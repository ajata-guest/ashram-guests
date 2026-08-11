import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";

const TIMEZONE = "Asia/Kolkata";
const APPROVED_EMAILS = new Set(["atma.chetan108@gmail.com", "rajatbhatiaom@gmail.com"]);
const PERSON_TYPES = new Set(["Invited Guest", "Friend", "Visitor", "Event Staff", "Other"]);
const TEAM_ELIGIBLE_TYPES = new Set(["Friend", "Visitor", "Other"]);
const MEALS = ["Breakfast", "Lunch", "Dinner"];
const DIRECTORY_TIER = { PRIORITY: 1, TODAY: 2, UPCOMING: 3, PAST: 4 };
const DIRECTORY_TIER_LABEL = { 1: "Priority", 2: "Today", 3: "Upcoming", 4: "Past" };
const COLLECTIONS = [
  "guests", "visits", "visitRooms", "visitTravelLegs", "rooms", "mealOverrides",
  "meetings", "sevaTeams", "teamMemberships", "specificSeva", "trips",
  "tripParticipants", "tripTravelLegs"
];

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function uuid() {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function millis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampFromInput(dateKey, time, endOfDay = false) {
  if (!dateKey) return null;
  const clock = time || (endOfDay ? "23:59:59.999" : "00:00:00.000");
  const date = new Date(`${dateKey}T${clock}+05:30`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date or time: ${dateKey} ${time || ""}`.trim());
  return Timestamp.fromDate(date);
}

function partsInIndia(value) {
  const ms = millis(value);
  if (ms === null) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, time: `${map.hour}:${map.minute}` };
}

function dateKeyOf(value) {
  return partsInIndia(value)?.date || "";
}

function serializeDate(value, timeConfirmed) {
  const ms = millis(value);
  if (ms === null) return { date: "", time: "", display: "", ms: null };
  const parts = partsInIndia(ms);
  const options = { timeZone: TIMEZONE, weekday: "short", day: "2-digit", month: "short", year: "numeric" };
  const dayText = new Intl.DateTimeFormat("en-GB", options).format(new Date(ms));
  const timeText = timeConfirmed ? parts.time : "";
  const display = timeConfirmed
    ? `${dayText} at ${new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(ms))}`
    : dayText;
  return { date: parts.date, time: timeText, display, ms };
}

function sameTime(a, b) {
  const left = millis(a), right = millis(b);
  return left === right;
}

function versionOf(data) {
  return millis(data?.updatedAt) || 0;
}

function assertVersion(data, supplied) {
  if (supplied === "" || supplied === null || supplied === undefined) return;
  const expected = Number(supplied);
  const actual = versionOf(data);
  if (Number.isFinite(expected) && expected !== actual) {
    throw new Error("This record was changed on another device. Refresh and try again.");
  }
}

function groupBy(rows, key) {
  const grouped = {};
  rows.forEach(row => { (grouped[row[key]] = grouped[row[key]] || []).push(row); });
  return grouped;
}

function tripStatus(trip, now = Date.now()) {
  if (trip.isCancelled) return "Cancelled";
  const start = millis(trip.startAt), end = millis(trip.endAt);
  if (start !== null && now < start) return "Upcoming";
  if (end !== null && now > end) return "Completed";
  if (start === null && end === null) return "Upcoming";
  return "Active";
}

function sevaStatus(item, allowDateless, now = Date.now()) {
  const start = millis(item.startAt), end = millis(item.endAt);
  if (allowDateless && start === null && end === null) return "Seva dates TBD";
  if (start !== null && now < start) return "Seva not started";
  if (end !== null && now > end) return "Seva completed";
  return "Seva active";
}

function travelView(leg) {
  const info = serializeDate(leg.travelAt, leg.timeConfirmed);
  return {
    legId: leg.id,
    order: Number(leg.order) || 1,
    direction: leg.direction || "Inbound",
    transportType: leg.transportType || "Other",
    from: leg.from || "",
    to: leg.to || "",
    travelDate: leg.travelDateKey || info.date,
    travelTime: info.time,
    travelDisplay: info.display,
    travelMs: info.ms,
    timeConfirmed: Boolean(leg.timeConfirmed),
    status: leg.status || "Required",
    serviceNumber: leg.serviceNumber || "",
    bookingReference: leg.bookingReference || "",
    notes: leg.notes || "",
    version: versionOf(leg)
  };
}

function cabScheduleInvalid(type, cabAt, stayAt) {
  const cab = millis(cabAt), stay = millis(stayAt);
  if (cab === null || stay === null) return false;
  return type === "pickup" ? cab > stay : cab < stay;
}

function cabState(visit, type) {
  const required = Boolean(visit[`${type}Required`]);
  if (!required) return "";
  const cabAt = visit[`${type}At`];
  const stayAt = visit[type === "pickup" ? "arrivalAt" : "departureAt"];
  if (cabScheduleInvalid(type, cabAt, stayAt)) return "Needs Rescheduling";
  if (!visit[`${type}BookingConfirmed`]) return "Requested";
  const confirmedStay = visit[type === "pickup" ? "pickupConfirmedAgainstArrival" : "dropoffConfirmedAgainstDeparture"];
  const confirmedCab = visit[`${type}ConfirmedCabTime`];
  if (!sameTime(confirmedStay, stayAt) || !sameTime(confirmedCab, cabAt)) return "Needs Reconfirmation";
  return "Confirmed";
}

function visitView(visit, roomsByVisit, legsByVisit) {
  const arrival = serializeDate(visit.arrivalAt, visit.arrivalTimeConfirmed);
  const departure = serializeDate(visit.departureAt, visit.departureTimeConfirmed);
  const pickup = serializeDate(visit.pickupAt, visit.pickupTimeConfirmed);
  const dropoff = serializeDate(visit.dropoffAt, visit.dropoffTimeConfirmed);
  return {
    visitId: visit.id,
    guestId: visit.guestId,
    arrivalMs: arrival.ms,
    arrivalDate: visit.arrivalDateKey || arrival.date,
    arrivalTime: arrival.time,
    arrivalDisplay: arrival.display,
    arrivalTimeConfirmed: Boolean(visit.arrivalTimeConfirmed),
    departureMs: departure.ms,
    departureDate: visit.departureDateKey || departure.date,
    departureTime: departure.time,
    departureDisplay: departure.display,
    departureTimeConfirmed: Boolean(visit.departureTimeConfirmed),
    accommodation: visit.accommodation || "TBD",
    outsideAccommodationDetails: visit.outsideAccommodationDetails || "",
    outsideAccommodationConfirmed: Boolean(visit.outsideAccommodationConfirmed),
    selfArrangedStayingAt: visit.stayingAt || "",
    cformComplete: Boolean(visit.cFormComplete),
    pickupRequired: Boolean(visit.pickupRequired),
    pickupMs: visit.pickupRequired ? pickup.ms : null,
    pickupDate: visit.pickupRequired ? (visit.pickupDateKey || pickup.date) : "",
    pickupTime: visit.pickupRequired ? pickup.time : "",
    pickupFrom: visit.pickupRequired ? (visit.pickupFrom || "") : "",
    pickupDetails: visit.pickupRequired ? (visit.pickupDetails || "") : "",
    pickupBookingConfirmed: Boolean(visit.pickupBookingConfirmed),
    pickupBookingState: cabState(visit, "pickup"),
    dropoffRequired: Boolean(visit.dropoffRequired),
    dropoffMs: visit.dropoffRequired ? dropoff.ms : null,
    dropoffDate: visit.dropoffRequired ? (visit.dropoffDateKey || dropoff.date) : "",
    dropoffTime: visit.dropoffRequired ? dropoff.time : "",
    dropoffTo: visit.dropoffRequired ? (visit.dropoffTo || "") : "",
    dropoffDetails: visit.dropoffRequired ? (visit.dropoffDetails || "") : "",
    dropoffBookingConfirmed: Boolean(visit.dropoffBookingConfirmed),
    dropoffBookingState: cabState(visit, "dropoff"),
    cancelled: Boolean(visit.isCancelled),
    cancelledAt: visit.cancelledAt || null,
    createdAt: visit.createdAt || null,
    createdBy: visit.createdBy || null,
    updatedBy: visit.updatedBy || null,
    version: versionOf(visit),
    rooms: (roomsByVisit[visit.id] || []).sort((a, b) => (a.order || 0) - (b.order || 0)).map(row => row.roomLabelSnapshot),
    travelLegs: (legsByVisit[visit.id] || []).map(travelView).sort((a, b) => a.order - b.order)
  };
}

function meetingView(meeting) {
  const info = serializeDate(meeting.startAt, meeting.timeConfirmed);
  return {
    meetingId: meeting.id,
    meetingOrder: Number(meeting.order) || 1,
    date: meeting.dateKey || info.date,
    time: info.time,
    display: info.display,
    ms: info.ms,
    timeConfirmed: Boolean(meeting.timeConfirmed),
    notes: meeting.notes || "",
    status: meeting.status || "Scheduled",
    version: versionOf(meeting)
  };
}

function taskView(task) {
  return {
    sevaId: task.id,
    sevaOrder: Number(task.order) || 1,
    description: task.description || "",
    startDate: task.startDateKey || dateKeyOf(task.startAt),
    startMs: millis(task.startAt),
    endDate: task.endDateKey || dateKeyOf(task.endAt),
    endMs: millis(task.endAt),
    status: sevaStatus(task, true),
    version: versionOf(task)
  };
}

function teamView(team) {
  return {
    teamId: team.id,
    name: team.eventProgrammeName || "",
    startDate: team.startDateKey || dateKeyOf(team.startAt),
    startMs: millis(team.startAt),
    endDate: team.endDateKey || dateKeyOf(team.endAt),
    endMs: millis(team.endAt),
    status: sevaStatus(team, false),
    version: versionOf(team)
  };
}

function tripView(trip) {
  return {
    tripId: trip.id,
    name: trip.name || "",
    purpose: trip.purpose || "",
    startDate: trip.startDateKey || dateKeyOf(trip.startAt),
    startMs: millis(trip.startAt),
    endDate: trip.endDateKey || dateKeyOf(trip.endAt),
    endMs: millis(trip.endAt),
    cancelled: Boolean(trip.isCancelled),
    cancelledAt: trip.cancelledAt || null,
    notes: trip.notes || "",
    status: tripStatus(trip),
    version: versionOf(trip)
  };
}

function findCurrentOrNearestVisit(visits, now = Date.now()) {
  if (!visits.length) return null;
  const current = visits.filter(v => v.arrivalMs !== null && v.arrivalMs <= now && (v.departureMs === null || v.departureMs >= now))
    .sort((a, b) => (b.arrivalMs || 0) - (a.arrivalMs || 0));
  if (current.length) return current[0];
  const upcoming = visits.filter(v => v.arrivalMs !== null && v.arrivalMs > now).sort((a, b) => a.arrivalMs - b.arrivalMs);
  if (upcoming.length) return upcoming[0];
  const dateless = visits.find(v => v.arrivalMs === null && v.departureMs === null);
  if (dateless) return dateless;
  return visits.slice().sort((a, b) => (b.departureMs || b.arrivalMs || 0) - (a.departureMs || a.arrivalMs || 0))[0];
}

function stayWindows(visits) {
  return visits.filter(v => !v.cancelled && v.arrivalDate).map(v => ({ from: v.arrivalDate, to: v.departureDate || "" }));
}

function engagementsOutside(visits, engagements) {
  const windows = stayWindows(visits);
  if (!windows.length) return [];
  const outside = key => key && !windows.some(window => key >= window.from && (!window.to || key <= window.to));
  const result = [];
  (engagements.meetings || []).forEach(item => { if (item.status === "Scheduled" && outside(item.date)) result.push({ kind: "Meeting with Swamiji", date: item.date }); });
  (engagements.meals || []).forEach(item => { if (outside(item.date)) result.push({ kind: `${item.meal} meal`, date: item.date }); });
  (engagements.specificSeva || []).forEach(item => { if (outside(item.startDate)) result.push({ kind: `Seva: ${item.description || "task"}`, date: item.startDate }); });
  return result;
}

function isAshramResident(visit, todayKey) {
  return Boolean(visit && visit.accommodation === "Ashram" && visit.arrivalDate && visit.arrivalDate <= todayKey
    && (!visit.departureDate || visit.departureDate >= todayKey));
}

function priorityReasons(record, now, todayKey) {
  const reasons = [];
  (record.upcomingMeetings || []).forEach(meeting => {
    if (meeting.status === "Scheduled" && meeting.date && meeting.date < todayKey) reasons.push("Meeting needs completion");
  });
  (record.specificSeva || []).forEach(task => { if (!task.startDate && !task.endDate) reasons.push("Seva dates not set"); });
  const visit = record.visit;
  if (!visit) return reasons;
  const stayOver = visit.departureMs !== null && visit.departureMs < now;
  const cabEligible = record.personType !== "Visitor";
  if (cabEligible && !stayOver) {
    (visit.travelLegs || []).forEach(leg => {
      if (leg.status === "Required") reasons.push(`${String(leg.direction || "").toLowerCase()} ${String(leg.transportType || "travel").toLowerCase()} required`.trim());
    });
  }
  if (stayOver) return reasons;
  if (!visit.arrivalDate) reasons.push("Arrival date not set");
  if (visit.accommodation === "TBD") reasons.push("Accommodation not decided");
  if (visit.accommodation === "Outside - Arranged by Ashram" && !visit.outsideAccommodationConfirmed) reasons.push("Outside accommodation not confirmed");
  if (visit.accommodation === "Ashram" && !visit.rooms.length) reasons.push("Room missing");
  if (record.isForeign && !visit.cformComplete && ["Ashram", "Outside - Arranged by Ashram"].includes(visit.accommodation)
      && visit.arrivalMs !== null && visit.arrivalMs <= now) reasons.push("C-form pending");
  if (cabEligible) {
    [["pickup", "Pickup"], ["dropoff", "Drop-off"]].forEach(([key, label]) => {
      if (!visit[`${key}Required`]) return;
      const state = visit[`${key}BookingState`];
      if (state === "Needs Rescheduling") reasons.push(`${label} needs rescheduling`);
      else if (state === "Needs Reconfirmation") reasons.push(`${label} needs reconfirmation`);
      else if (state !== "Confirmed") reasons.push(`${label} not arranged`);
    });
  }
  if ((record.engagementsOutsideStay || []).length) reasons.push("Engagements outside stay dates");
  return reasons;
}

function directoryTier(record, reasons, todayKey) {
  if (reasons.length) return DIRECTORY_TIER.PRIORITY;
  const visit = record.visit;
  const happensToday = (visit && [visit.arrivalDate, visit.departureDate].includes(todayKey))
    || (record.mealsToday || []).length
    || (record.upcomingMeetings || []).some(item => item.status === "Scheduled" && item.date === todayKey);
  if (happensToday) return DIRECTORY_TIER.TODAY;
  const future = (visit && ((!visit.arrivalDate && !visit.departureDate) || !visit.departureDate || visit.arrivalDate > todayKey || visit.departureDate > todayKey))
    || (record.upcomingMeetings || []).some(item => item.status === "Scheduled" && item.date > todayKey)
    || (record.specificSeva || []).some(item => !item.endDate || item.endDate >= todayKey)
    || (record.sevaTeams || []).some(item => item.status !== "Seva completed")
    || (record.trips || []).some(item => ["Active", "Upcoming"].includes(item.status));
  return future ? DIRECTORY_TIER.UPCOMING : DIRECTORY_TIER.PAST;
}

function tierCounts(records) {
  const counts = { priority: 0, today: 0, upcoming: 0, past: 0, all: records.length };
  records.forEach(record => {
    if (record.tier === 1) counts.priority += 1;
    else if (record.tier === 2) counts.today += 1;
    else if (record.tier === 3) counts.upcoming += 1;
    else counts.past += 1;
  });
  return counts;
}

function roomInventory(canonical) {
  return canonical.rooms.filter(room => room.active !== false).map(room => ({
    roomId: room.id,
    building: room.building,
    room: room.room,
    category: room.category || "Normal",
    permanent: Boolean(room.permanent),
    occupant: room.occupant || "",
    capacity: Number(room.capacity) || 1,
    value: room.displayName || `${room.building} - ${room.room}`
  })).sort((a, b) => a.value.localeCompare(b.value));
}

function buildDirectoryRecords(canonical, includeArchived = false) {
  const now = Date.now();
  const todayKey = dateKeyOf(now);
  const visitsByGuest = groupBy(canonical.visits, "guestId");
  const roomsByVisit = groupBy(canonical.visitRooms, "visitId");
  const legsByVisit = groupBy(canonical.visitTravelLegs, "visitId");
  const mealsByGuest = groupBy(canonical.mealOverrides, "guestId");
  const meetingsByGuest = groupBy(canonical.meetings, "guestId");
  const tasksByGuest = groupBy(canonical.specificSeva, "guestId");
  const membershipsByGuest = groupBy(canonical.teamMemberships, "guestId");
  const participantsByGuest = groupBy(canonical.tripParticipants, "guestId");
  const teamsById = Object.fromEntries(canonical.sevaTeams.map(team => [team.id, team]));
  const tripsById = Object.fromEntries(canonical.trips.map(trip => [trip.id, trip]));

  return canonical.guests.filter(guest => includeArchived || !guest.archived).map(guest => {
    const allVisits = (visitsByGuest[guest.id] || []).filter(visit => !visit.isCancelled).map(visit => visitView(visit, roomsByVisit, legsByVisit));
    const meetings = (meetingsByGuest[guest.id] || []).map(meetingView);
    const tasks = (tasksByGuest[guest.id] || []).map(taskView);
    const meals = (mealsByGuest[guest.id] || []).map(item => ({ overrideId: item.id, date: item.dateKey, meal: item.meal, included: Boolean(item.included) }));
    const teams = (membershipsByGuest[guest.id] || []).map(membership => teamsById[membership.teamId]).filter(Boolean).map(teamView);
    const trips = (participantsByGuest[guest.id] || []).map(participant => tripsById[participant.tripId]).filter(Boolean).map(tripView);
    const record = {
      guestId: guest.id,
      name: guest.name || "",
      personType: PERSON_TYPES.has(guest.personType) ? guest.personType : "Needs Review",
      isForeign: Boolean(guest.foreignNational),
      invitedPurpose: Array.isArray(guest.invitedPurposes) ? guest.invitedPurposes : [],
      invitedPurposeOther: guest.invitedPurposeOther || "",
      staffAssignment: guest.staffAssignment || "",
      archived: Boolean(guest.archived),
      version: versionOf(guest),
      visit: findCurrentOrNearestVisit(allVisits, now),
      visitCount: allVisits.length,
      sevaTeams: teams,
      specificSeva: tasks,
      mealsToday: meals.filter(item => item.date === todayKey),
      upcomingMeetings: meetings.filter(item => item.status === "Scheduled"),
      nextMeeting: meetings.filter(item => item.status === "Scheduled" && item.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date))[0] || null,
      trips
    };
    record.engagementsOutsideStay = engagementsOutside(allVisits, { meetings, meals, specificSeva: tasks });
    record.priorityReasons = priorityReasons(record, now, todayKey);
    record.tier = directoryTier(record, record.priorityReasons, todayKey);
    record.tierLabel = DIRECTORY_TIER_LABEL[record.tier];
    record.residingInAshram = isAshramResident(record.visit, todayKey);
    return record;
  });
}

function homeSummary(canonical, records) {
  const today = dateKeyOf(Date.now());
  const result = {
    generatedAt: Date.now(),
    directory: { total: records.length, needsAttention: 0 },
    accommodation: { arrivingToday: 0, departingToday: 0, currentlyResiding: 0, attentionNeeded: 0 },
    meals: { counts: { Breakfast: 0, Lunch: 0, Dinner: 0 }, residentCount: 0, exceptionCount: 0 },
    meetings: { today: 0, upcoming: 0, needsCompletion: 0 },
    seva: { activeTeams: 0, activeTeamMembers: 0, activeSpecificSeva: 0, startingSoon: 0 },
    trips: { active: 0, upcoming: 0, needingTravel: 0 }
  };
  const activeTeams = new Set(), futureTeams = new Set();
  records.forEach(record => {
    if (record.priorityReasons.length) result.directory.needsAttention += 1;
    const visit = record.visit;
    if (visit) {
      if (visit.arrivalDate === today) result.accommodation.arrivingToday += 1;
      if (visit.departureDate === today) result.accommodation.departingToday += 1;
      if (record.residingInAshram) result.accommodation.currentlyResiding += 1;
      if (record.priorityReasons.some(reason => /arrival|accommodation|room|c-form|pickup|drop-off|required/i.test(reason))) result.accommodation.attentionNeeded += 1;
    }
    const defaults = Boolean(record.residingInAshram);
    if (defaults) result.meals.residentCount += 1;
    const overrideMap = Object.fromEntries(record.mealsToday.map(item => [item.meal, item]));
    MEALS.forEach(meal => {
      const override = overrideMap[meal];
      if (override) result.meals.exceptionCount += 1;
      if (override ? override.included : defaults) result.meals.counts[meal] += 1;
    });
    record.upcomingMeetings.forEach(meeting => {
      if (meeting.date === today) result.meetings.today += 1;
      else if (meeting.date < today) result.meetings.needsCompletion += 1;
      else result.meetings.upcoming += 1;
    });
    let activeMember = false;
    record.sevaTeams.forEach(team => {
      if (team.status === "Seva active") { activeTeams.add(team.teamId); activeMember = true; }
      if (team.status === "Seva not started") futureTeams.add(team.teamId);
    });
    if (activeMember) result.seva.activeTeamMembers += 1;
    result.seva.activeSpecificSeva += record.specificSeva.filter(task => task.status === "Seva active").length;
  });
  result.seva.activeTeams = activeTeams.size;
  result.seva.startingSoon = futureTeams.size;
  const legsByTrip = groupBy(canonical.tripTravelLegs, "tripId");
  canonical.trips.map(tripView).forEach(trip => {
    if (trip.status === "Active") result.trips.active += 1;
    if (trip.status === "Upcoming") result.trips.upcoming += 1;
    if (["Active", "Upcoming"].includes(trip.status) && (legsByTrip[trip.tripId] || []).some(leg => leg.status === "Required")) result.trips.needingTravel += 1;
  });
  return result;
}

function auditEntry(actorEmail, entityType, entityId, action, changedFields = []) {
  return {
    entityType,
    entityId,
    action,
    actorEmail,
    createdAt: serverTimestamp(),
    changedFields,
    schemaVersion: 1
  };
}

export function createFirestoreBridge(firebaseApp) {
  let db;
  try {
    db = initializeFirestore(firebaseApp, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    }, "(default)");
  } catch (error) {
    db = getFirestore(firebaseApp, "(default)");
  }
  const auth = getAuth(firebaseApp);
  setPersistence(auth, browserLocalPersistence).catch(() => {});
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  let canonicalCache = null;
  let canonicalPromise = null;
  let cacheGeneration = 0;
  let remoteUnsubscribe = null;
  let initialAuditSnapshotSeen = false;

  function invalidate() {
    cacheGeneration += 1;
    canonicalCache = null;
    canonicalPromise = null;
  }

  function authError(message) {
    const error = new Error(message);
    error.isAuthError = true;
    return error;
  }

  function accessError(message) {
    const error = new Error(message);
    error.isAccessDenied = true;
    return error;
  }

  function currentEmail() {
    return clean(auth.currentUser?.email, 200).toLowerCase();
  }

  function ensureApproved() {
    if (!auth.currentUser) throw authError("Please sign in again.");
    if (!APPROVED_EMAILS.has(currentEmail())) throw accessError("Access denied for this Google account.");
    return currentEmail();
  }

  async function readCollection(name, constraints = []) {
    const source = constraints.length ? query(collection(db, name), ...constraints) : collection(db, name);
    const snapshot = await getDocs(source);
    return snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
  }

  function refreshCanonical_(force = false) {
    // A forced read must not settle for one that was already in flight before
    // it was asked for. Every write path calls loadCanonical(true) to validate
    // against current server state — room conflicts, engagement windows,
    // "this guest has history" — so piggybacking on an older request would let
    // a save be checked against data from before that save was attempted.
    if (canonicalPromise && !force) return canonicalPromise;
    const generation = cacheGeneration;
    const request = Promise.all(COLLECTIONS.map(readCollection)).then(all => {
      const nextCanonical = Object.fromEntries(COLLECTIONS.map((name, index) => [name, all[index]]));
      // A local write or audit event may invalidate while these reads are in
      // flight. Never let an older request repopulate the cache afterward.
      if (generation === cacheGeneration) canonicalCache = nextCanonical;
      return nextCanonical;
    }).catch(error => {
      if (error?.code === "permission-denied") throw accessError("Access denied for this Google account.");
      throw error;
    }).finally(() => {
      if (canonicalPromise === request) canonicalPromise = null;
    });
    canonicalPromise = request;
    return request;
  }

  async function loadCanonical(force = false) {
    ensureApproved();
    // Cache lifetime is event-driven. Local writes and the audit listener call
    // invalidate(); ordinary navigation and idle time do not expire it.
    if (!force && canonicalCache) return canonicalCache;
    return refreshCanonical_(force);
  }

  async function directorySnapshot(options = {}) {
    const canonical = await loadCanonical();
    const guests = buildDirectoryRecords(canonical, Boolean(options.includeArchived));
    return {
      guests,
      total: guests.length,
      tierCounts: tierCounts(guests),
      rooms: roomInventory(canonical),
      timezone: TIMEZONE,
      generatedAt: Date.now()
    };
  }

  async function bootstrap() {
    const canonical = await loadCanonical();
    const guests = buildDirectoryRecords(canonical, false);
    const generatedAt = Date.now();
    return {
      summary: homeSummary(canonical, guests),
      directory: {
        guests,
        total: guests.length,
        tierCounts: tierCounts(guests),
        rooms: roomInventory(canonical),
        timezone: TIMEZONE,
        generatedAt
      },
      generatedAt
    };
  }

  async function guestProfile(guestId) {
    const id = clean(guestId, 100);
    const canonical = await loadCanonical();
    const guest = canonical.guests.find(item => item.id === id);
    if (!guest) throw new Error("This guest no longer exists.");
    const roomsByVisit = groupBy(canonical.visitRooms, "visitId");
    const legsByVisit = groupBy(canonical.visitTravelLegs, "visitId");
    const visits = canonical.visits.filter(item => item.guestId === id).map(item => visitView(item, roomsByVisit, legsByVisit));
    const liveVisits = visits.filter(item => !item.cancelled);
    const mealOverrides = canonical.mealOverrides.filter(item => item.guestId === id).map(item => ({
      overrideId: item.id, date: item.dateKey, meal: item.meal, included: Boolean(item.included), version: versionOf(item)
    }));
    const meetings = canonical.meetings.filter(item => item.guestId === id).map(meetingView);
    const specificSeva = canonical.specificSeva.filter(item => item.guestId === id).map(taskView);
    const teamsById = Object.fromEntries(canonical.sevaTeams.map(item => [item.id, item]));
    const sevaTeams = canonical.teamMemberships.filter(item => item.guestId === id).map(item => teamsById[item.teamId]).filter(Boolean).map(teamView);
    const tripsById = Object.fromEntries(canonical.trips.map(item => [item.id, item]));
    const trips = canonical.tripParticipants.filter(item => item.guestId === id).map(item => {
      const trip = tripsById[item.tripId];
      return trip ? { participantId: item.id, ...tripView(trip) } : null;
    }).filter(Boolean);
    const hasHistory = visits.length || mealOverrides.length || meetings.length || specificSeva.length || sevaTeams.length || trips.length;
    return {
      guestId: guest.id,
      name: guest.name || "",
      personType: PERSON_TYPES.has(guest.personType) ? guest.personType : "Needs Review",
      isForeign: Boolean(guest.foreignNational),
      invitedPurpose: Array.isArray(guest.invitedPurposes) ? guest.invitedPurposes : [],
      invitedPurposeOther: guest.invitedPurposeOther || "",
      staffAssignment: guest.staffAssignment || "",
      archived: Boolean(guest.archived),
      version: versionOf(guest),
      visits,
      currentVisit: findCurrentOrNearestVisit(liveVisits),
      sevaTeams,
      specificSeva,
      mealOverrides,
      meetings,
      trips,
      canHardDelete: !hasHistory,
      engagementsOutsideStay: engagementsOutside(liveVisits, { meetings, meals: mealOverrides, specificSeva })
    };
  }

  async function accommodationWorkspace() {
    const canonical = await loadCanonical();
    const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
    const roomsByVisit = groupBy(canonical.visitRooms, "visitId");
    const legsByVisit = groupBy(canonical.visitTravelLegs, "visitId");
    const visits = canonical.visits.filter(item => !item.isCancelled).map(item => {
      const guest = guestsById[item.guestId];
      if (!guest) return null;
      const view = visitView(item, roomsByVisit, legsByVisit);
      return {
        ...view,
        name: guest.name,
        personType: guest.personType,
        isForeign: Boolean(guest.foreignNational)
      };
    }).filter(Boolean);
    return { visits, generatedAt: Date.now() };
  }

  async function mealsWorkspace(filters = {}) {
    const canonical = await loadCanonical();
    const date = clean(filters.date, 20) || dateKeyOf(Date.now());
    const activeGuests = canonical.guests.filter(item => !item.archived);
    const visitsByGuest = groupBy(canonical.visits.filter(item => !item.isCancelled), "guestId");
    const overrides = canonical.mealOverrides.filter(item => item.dateKey === date);
    const overridesByGuest = groupBy(overrides, "guestId");
    const counts = { Breakfast: 0, Lunch: 0, Dinner: 0 };
    let residentCount = 0, exceptionCount = 0;
    const guests = activeGuests.map(guest => {
      const isResident = (visitsByGuest[guest.id] || []).some(visit => visit.accommodation === "Ashram"
        && visit.arrivalDateKey && visit.arrivalDateKey <= date && (!visit.departureDateKey || visit.departureDateKey >= date));
      if (isResident) residentCount += 1;
      const byMeal = Object.fromEntries((overridesByGuest[guest.id] || []).map(item => [item.meal, item]));
      const meals = {};
      MEALS.forEach(meal => {
        const override = byMeal[meal];
        const included = override ? Boolean(override.included) : isResident;
        if (included) counts[meal] += 1;
        if (override) exceptionCount += 1;
        meals[meal] = { included, overrideId: override?.id || null, isException: Boolean(override) };
      });
      return { guestId: guest.id, name: guest.name, personType: guest.personType, isResident, meals };
    }).filter(row => row.isResident || MEALS.some(meal => row.meals[meal].included));
    return { date, guests, counts, residentCount, exceptionCount, generatedAt: Date.now() };
  }

  async function meetingsWorkspace() {
    const canonical = await loadCanonical();
    const today = dateKeyOf(Date.now());
    const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
    const meetings = canonical.meetings.map(item => {
      const guest = guestsById[item.guestId];
      return guest ? { guestId: guest.id, name: guest.name, ...meetingView(item) } : null;
    }).filter(Boolean);
    return {
      today: meetings.filter(item => item.status === "Scheduled" && item.date === today),
      upcoming: meetings.filter(item => item.status === "Scheduled" && item.date > today),
      needsCompletion: meetings.filter(item => item.status === "Scheduled" && item.date && item.date < today),
      completed: meetings.filter(item => item.status === "Completed"),
      cancelled: meetings.filter(item => item.status === "Cancelled"),
      generatedAt: Date.now()
    };
  }

  async function sevaWorkspace() {
    const canonical = await loadCanonical();
    const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
    const membersByTeam = groupBy(canonical.teamMemberships, "teamId");
    const teams = canonical.sevaTeams.map(team => ({
      ...teamView(team),
      roster: (membersByTeam[team.id] || []).map(member => {
        const guest = guestsById[member.guestId];
        return guest ? { guestId: guest.id, membershipId: member.id, name: guest.name, personType: guest.personType } : null;
      }).filter(Boolean)
    }));
    const individualTasks = canonical.specificSeva.map(task => {
      const guest = guestsById[task.guestId];
      return guest ? { guestId: guest.id, name: guest.name, personType: guest.personType, ...taskView(task) } : null;
    }).filter(Boolean);
    return { teams, individualTasks, generatedAt: Date.now() };
  }

  async function tripsWorkspace() {
    const canonical = await loadCanonical();
    const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
    const participantsByTrip = groupBy(canonical.tripParticipants, "tripId");
    const legsByTrip = groupBy(canonical.tripTravelLegs, "tripId");
    const trips = canonical.trips.map(trip => {
      const participants = (participantsByTrip[trip.id] || []).map(item => {
        const guest = guestsById[item.guestId];
        return guest ? { participantId: item.id, guestId: guest.id, name: guest.name, personType: guest.personType } : null;
      }).filter(Boolean);
      const legs = (legsByTrip[trip.id] || []).map(travelView).sort((a, b) => a.order - b.order);
      return { ...tripView(trip), participants, participantCount: participants.length, legs, unresolvedLegCount: legs.filter(item => item.status === "Required").length };
    });
    return { trips, generatedAt: Date.now() };
  }

  async function workspaceData(workspace, filters) {
    if (workspace === "accommodation") return accommodationWorkspace(filters);
    if (workspace === "meals") return mealsWorkspace(filters);
    if (workspace === "meetings") return meetingsWorkspace(filters);
    if (workspace === "seva") return sevaWorkspace(filters);
    if (workspace === "trips") return tripsWorkspace(filters);
    throw new Error(`Unknown workspace: ${workspace}`);
  }

  async function writeAuditBatch(batch, actor, type, id, action, fields) {
    batch.set(doc(collection(db, "auditLogs")), auditEntry(actor, type, id, action, fields));
  }

  async function committedVersion(collectionName, id) {
    const snapshot = await getDoc(doc(db, collectionName, id));
    return snapshot.exists() ? versionOf(snapshot.data()) : 0;
  }

  async function simpleTransaction(collectionName, id, suppliedVersion, transform, action, fields) {
    const actor = ensureApproved();
    const reference = doc(db, collectionName, id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("This record no longer exists.");
      assertVersion(snapshot.data(), suppliedVersion);
      const patch = transform(snapshot.data());
      transaction.update(reference, { ...patch, updatedAt: serverTimestamp(), updatedBy: actor });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, collectionName, id, action, fields));
    });
    invalidate();
    return { id, version: await committedVersion(collectionName, id) };
  }

  function guestWriteData(payload, actor, existing = null) {
    const name = clean(payload.name);
    const personType = clean(payload.personType, 100) || "Invited Guest";
    if (!name) throw new Error("Guest name is required.");
    if (!PERSON_TYPES.has(personType)) throw new Error("Unrecognized Person Type.");
    const invitedPurposes = personType === "Invited Guest"
      ? [...new Set((Array.isArray(payload.invitedPurpose) ? payload.invitedPurpose : []).map(item => clean(item, 100)).filter(Boolean))]
      : [];
    return {
      name,
      nameNormalized: name.toLowerCase(),
      foreignNational: Boolean(payload.isForeign),
      personType,
      invitedPurposes,
      invitedPurposeOther: personType === "Invited Guest" ? clean(payload.invitedPurposeOther) : "",
      staffAssignment: personType === "Event Staff" ? clean(payload.staffAssignment) : "",
      archived: Boolean(existing?.archived),
      archivedAt: existing?.archivedAt || null,
      schemaVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: actor
    };
  }

  async function createGuest(payload) {
    const actor = ensureApproved();
    const id = clean(payload?.guestId, 100) || uuid();
    const reference = doc(db, "guests", id);
    const data = guestWriteData(payload || {}, actor);
    await runTransaction(db, async transaction => {
      if ((await transaction.get(reference)).exists()) throw new Error("A guest with this ID already exists.");
      transaction.set(reference, { ...data, createdAt: serverTimestamp(), createdBy: actor });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "guest", id, "create", ["name", "personType"]));
    });
    invalidate();
    return { guestId: id, version: await committedVersion("guests", id) };
  }

  async function updateGuestBasics(payload) {
    const actor = ensureApproved();
    const id = clean(payload?.guestId, 100);
    if (!id) throw new Error("A Guest ID is required.");
    const reference = doc(db, "guests", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("This guest no longer exists.");
      assertVersion(snapshot.data(), payload.version);
      transaction.update(reference, guestWriteData(payload, actor, snapshot.data()));
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "guest", id, "update-basics", ["name", "personType", "foreignNational", "invitedPurposes", "staffAssignment"]));
    });
    invalidate();
    return { guestId: id, version: await committedVersion("guests", id) };
  }

  async function setGuestArchived(guestId, suppliedVersion, archived) {
    const result = await simpleTransaction("guests", clean(guestId, 100), suppliedVersion, () => ({
      archived,
      archivedAt: archived ? serverTimestamp() : null
    }), archived ? "archive" : "restore", ["archived", "archivedAt"]);
    return { guestId: result.id, archived, version: result.version };
  }

  async function deleteGuestRecord(guestId, suppliedVersion) {
    const actor = ensureApproved();
    const id = clean(guestId, 100);
    const canonical = await loadCanonical(true);
    const hasHistory = canonical.visits.some(item => item.guestId === id)
      || canonical.mealOverrides.some(item => item.guestId === id)
      || canonical.meetings.some(item => item.guestId === id)
      || canonical.teamMemberships.some(item => item.guestId === id)
      || canonical.specificSeva.some(item => item.guestId === id)
      || canonical.tripParticipants.some(item => item.guestId === id);
    if (hasHistory) throw new Error("This guest has operational history and cannot be permanently deleted. Archive the guest instead.");
    const reference = doc(db, "guests", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("This guest no longer exists.");
      assertVersion(snapshot.data(), suppliedVersion);
      transaction.delete(reference);
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "guest", id, "delete", ["document"]));
    });
    invalidate();
    return { guestId: id, deleted: true };
  }

  function overlap(startA, endA, startB, endB) {
    if (startA === null || startB === null) return false;
    return startA < (endB ?? Number.POSITIVE_INFINITY) && (endA ?? Number.POSITIVE_INFINITY) > startB;
  }

  function validateEngagementDate(canonical, guestId, keys, label) {
    const dates = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!dates.length) return;
    const windows = canonical.visits.filter(item => item.guestId === guestId && !item.isCancelled && item.arrivalDateKey)
      .map(item => ({ from: item.arrivalDateKey, to: item.departureDateKey || "" }));
    if (!windows.length) return;
    const bad = dates.filter(key => !windows.some(window => key >= window.from && (!window.to || key <= window.to)));
    if (bad.length) throw new Error(`${label} on ${bad.join(", ")} falls outside this guest's stay dates.`);
  }

  function confirmationData(type, payload, existing, stayAt, cabAt) {
    const intent = clean(payload[`${type}ConfirmationIntent`], 40);
    const checked = Boolean(payload[`${type}BookingConfirmed`]);
    const prefix = type === "pickup" ? "pickup" : "dropoff";
    const stayField = type === "pickup" ? "pickupConfirmedAgainstArrival" : "dropoffConfirmedAgainstDeparture";
    const cabField = `${prefix}ConfirmedCabTime`;
    if (intent === "preserve" && existing) {
      return {
        [`${prefix}BookingConfirmed`]: Boolean(existing[`${prefix}BookingConfirmed`]),
        [stayField]: existing[stayField] || null,
        [cabField]: existing[cabField] || null
      };
    }
    if (checked) return { [`${prefix}BookingConfirmed`]: true, [stayField]: stayAt, [cabField]: cabAt };
    return { [`${prefix}BookingConfirmed`]: false, [stayField]: null, [cabField]: null };
  }

  async function saveVisitPlan(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const guestId = clean(payload?.guestId, 100);
    const guest = canonical.guests.find(item => item.id === guestId && !item.archived);
    if (!guest) throw new Error("This guest no longer exists.");
    const visitId = clean(payload.visitId, 100) || uuid();
    const existing = canonical.visits.find(item => item.id === visitId) || null;
    if (existing) assertVersion(existing, payload.version);

    const arrivalAt = timestampFromInput(clean(payload.arrivalDate, 20), clean(payload.arrivalTime, 20), false);
    const departureAt = timestampFromInput(clean(payload.departureDate, 20), clean(payload.departureTime, 20), true);
    if (millis(arrivalAt) !== null && millis(departureAt) !== null && millis(departureAt) < millis(arrivalAt)) {
      throw new Error("Departure cannot be earlier than arrival.");
    }
    const accommodation = clean(payload.accommodation, 100) || "TBD";
    const pickupAt = payload.pickupRequired ? timestampFromInput(clean(payload.pickupDate, 20), clean(payload.pickupTime, 20), false) : null;
    const dropoffAt = payload.dropoffRequired ? timestampFromInput(clean(payload.dropoffDate, 20), clean(payload.dropoffTime, 20), false) : null;
    if (payload.pickupRequired && cabScheduleInvalid("pickup", pickupAt, arrivalAt)) throw new Error("Pickup cannot be later than arrival.");
    if (payload.dropoffRequired && cabScheduleInvalid("dropoff", dropoffAt, departureAt)) throw new Error("Drop-off cannot be earlier than departure.");
    if (guest.personType === "Visitor" && (payload.pickupRequired || payload.dropoffRequired || (payload.travelLegs || []).length)) {
      throw new Error("Visitors do not use personal cab or travel planning. Add them to a shared Trip instead.");
    }

    const requestedRooms = [...new Set((Array.isArray(payload.rooms) ? payload.rooms : []).map(item => clean(item?.room || item, 300)).filter(Boolean))];
    if (accommodation !== "Ashram" && requestedRooms.length) throw new Error("Rooms can only be assigned to an Ashram stay.");
    const inventory = roomInventory(canonical);
    const inventoryByLabel = Object.fromEntries(inventory.map(item => [item.value, item]));
    requestedRooms.forEach(label => { if (!inventoryByLabel[label]) throw new Error(`Unknown room: ${label}`); });

    const existingRoomRows = canonical.visitRooms.filter(item => item.visitId === visitId);
    const existingLabels = new Set(existingRoomRows.map(item => item.roomLabelSnapshot));
    const shareAcks = new Set(Array.isArray(payload.sharedRoomAcks) ? payload.sharedRoomAcks : []);
    requestedRooms.forEach(label => {
      if (millis(arrivalAt) === null) return;
      const allocationRows = canonical.visitRooms.filter(item => item.visitId !== visitId && item.roomLabelSnapshot === label);
      const occupants = allocationRows.filter(allocation => {
        const other = canonical.visits.find(item => item.id === allocation.visitId && !item.isCancelled);
        return other && overlap(millis(arrivalAt), millis(departureAt), millis(other.arrivalAt), millis(other.departureAt));
      });
      const capacity = inventoryByLabel[label].capacity || 1;
      if (occupants.length >= capacity) throw new Error(`${label} is already at capacity for these dates.`);
      if (occupants.length && !existingLabels.has(label) && !shareAcks.has(label)) throw new Error(`Confirm sharing ${label} before saving.`);
    });

    const pickupConfirm = confirmationData("pickup", payload, existing, arrivalAt, pickupAt);
    const dropoffConfirm = confirmationData("dropoff", payload, existing, departureAt, dropoffAt);
    const visitData = {
      guestId,
      arrivalAt,
      arrivalDateKey: clean(payload.arrivalDate, 20),
      arrivalTimeConfirmed: Boolean(payload.arrivalTime),
      departureAt,
      departureDateKey: clean(payload.departureDate, 20),
      departureTimeConfirmed: Boolean(payload.departureTime),
      accommodation,
      outsideAccommodationDetails: clean(payload.outsideAccommodationDetails),
      outsideAccommodationConfirmed: Boolean(payload.outsideAccommodationConfirmed),
      stayingAt: clean(payload.selfArrangedStayingAt),
      cFormComplete: Boolean(payload.isCformComplete),
      pickupRequired: Boolean(payload.pickupRequired),
      pickupAt,
      pickupDateKey: payload.pickupRequired ? clean(payload.pickupDate, 20) : "",
      pickupTimeConfirmed: Boolean(payload.pickupRequired && payload.pickupTime),
      pickupFrom: payload.pickupRequired ? clean(payload.pickupFrom) : "",
      pickupDetails: payload.pickupRequired ? clean(payload.pickupDetails) : "",
      ...pickupConfirm,
      dropoffRequired: Boolean(payload.dropoffRequired),
      dropoffAt,
      dropoffDateKey: payload.dropoffRequired ? clean(payload.dropoffDate, 20) : "",
      dropoffTimeConfirmed: Boolean(payload.dropoffRequired && payload.dropoffTime),
      dropoffTo: payload.dropoffRequired ? clean(payload.dropoffTo) : "",
      dropoffDetails: payload.dropoffRequired ? clean(payload.dropoffDetails) : "",
      ...dropoffConfirm,
      isCancelled: Boolean(existing?.isCancelled),
      cancelledAt: existing?.cancelledAt || null,
      hasArrivalDate: Boolean(arrivalAt),
      calendarStartAt: arrivalAt,
      calendarEndAt: arrivalAt ? (departureAt || Timestamp.fromDate(new Date("2099-12-31T18:29:59.999Z"))) : null,
      schemaVersion: 1,
      updatedAt: serverTimestamp(),
      updatedBy: actor,
      createdAt: existing?.createdAt || serverTimestamp(),
      createdBy: existing?.createdBy || actor
    };

    const travelPayloads = Array.isArray(payload.travelLegs) ? payload.travelLegs : [];
    let previousTravelMs = null;
    travelPayloads.forEach((leg, index) => {
      const at = timestampFromInput(clean(leg.travelDate, 20), clean(leg.travelTime, 20), false);
      if (at && previousTravelMs !== null && millis(at) <= previousTravelMs) throw new Error(`Travel leg ${index + 1} must be later than the preceding dated leg.`);
      if (at) previousTravelMs = millis(at);
    });

    const visitRef = doc(db, "visits", visitId);
    const oldLegs = canonical.visitTravelLegs.filter(item => item.visitId === visitId);
    await runTransaction(db, async transaction => {
      const current = await transaction.get(visitRef);
      if (current.exists()) assertVersion(current.data(), payload.version);
      else if (existing) throw new Error("This visit no longer exists.");
      transaction.set(visitRef, visitData);

      const newRoomIds = new Set();
      requestedRooms.forEach((label, index) => {
        const inventoryItem = inventoryByLabel[label];
        const prior = existingRoomRows.find(item => item.roomLabelSnapshot === label);
        const allocationId = prior?.id || `${visitId}--${inventoryItem.roomId}`;
        newRoomIds.add(allocationId);
        transaction.set(doc(db, "visitRooms", allocationId), {
          visitId, roomId: inventoryItem.roomId, roomLabelSnapshot: label, order: index + 1,
          sharedOk: existingLabels.has(label) ? Boolean(prior?.sharedOk) : shareAcks.has(label),
          createdAt: prior?.createdAt || serverTimestamp(), createdBy: prior?.createdBy || actor,
          updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
        });
      });
      existingRoomRows.filter(item => !newRoomIds.has(item.id)).forEach(item => transaction.delete(doc(db, "visitRooms", item.id)));

      const newLegIds = new Set();
      travelPayloads.forEach((leg, index) => {
        const legId = clean(leg.travelId, 100) || uuid();
        newLegIds.add(legId);
        const old = oldLegs.find(item => item.id === legId);
        transaction.set(doc(db, "visitTravelLegs", legId), {
          visitId,
          direction: clean(leg.direction, 100) || "Inbound",
          transportType: clean(leg.transportType, 100) || "Other",
          from: clean(leg.from), to: clean(leg.to),
          travelAt: timestampFromInput(clean(leg.travelDate, 20), clean(leg.travelTime, 20), false),
          travelDateKey: clean(leg.travelDate, 20), timeConfirmed: Boolean(leg.travelTime),
          status: clean(leg.status, 100) || "Required", serviceNumber: clean(leg.serviceNumber),
          bookingReference: clean(leg.bookingReference), notes: clean(leg.notes), order: index + 1,
          createdAt: old?.createdAt || serverTimestamp(), createdBy: old?.createdBy || actor,
          updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
        });
      });
      oldLegs.filter(item => !newLegIds.has(item.id)).forEach(item => transaction.delete(doc(db, "visitTravelLegs", item.id)));
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "visit", visitId, existing ? "update" : "create", ["stay", "accommodation", "rooms", "cabs", "travelLegs"]));
    });
    invalidate();
    return { visitId, guestId, version: await committedVersion("visits", visitId) };
  }

  async function setVisitCancelled(visitId, suppliedVersion, cancelled) {
    const result = await simpleTransaction("visits", clean(visitId, 100), suppliedVersion, () => ({
      isCancelled: cancelled,
      cancelledAt: cancelled ? serverTimestamp() : null
    }), cancelled ? "cancel" : "restore", ["isCancelled", "cancelledAt"]);
    return { visitId: result.id, cancelled, version: result.version };
  }

  async function upsertMealOverride(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const guestId = clean(payload?.guestId, 100);
    const dateKey = clean(payload?.date, 20);
    const meal = clean(payload?.meal, 30);
    if (!canonical.guests.some(item => item.id === guestId && !item.archived)) throw new Error("This guest no longer exists.");
    if (!dateKey || !MEALS.includes(meal)) throw new Error("A valid date and meal are required.");
    validateEngagementDate(canonical, guestId, dateKey, `${meal} meal`);
    const requestedId = clean(payload.overrideId, 100);
    const naturalKeyMatch = canonical.mealOverrides.find(item => item.guestId === guestId && item.dateKey === dateKey && item.meal === meal);
    const id = requestedId || naturalKeyMatch?.id || `${guestId}--${dateKey}--${meal.toLowerCase()}`;
    const existing = canonical.mealOverrides.find(item => item.id === id);
    await setDoc(doc(db, "mealOverrides", id), {
      guestId, dateKey, meal, included: Boolean(payload.included),
      createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
      updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await setDoc(doc(collection(db, "auditLogs")), auditEntry(actor, "mealOverride", id, existing ? "update" : "create", ["included"]));
    invalidate();
    return { overrideId: id, version: await committedVersion("mealOverrides", id) };
  }

  async function upsertMeeting(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const guestId = clean(payload?.guestId, 100);
    const dateKey = clean(payload?.date, 20);
    if (!canonical.guests.some(item => item.id === guestId && !item.archived)) throw new Error("This guest no longer exists.");
    if (!dateKey) throw new Error("A meeting date is required.");
    validateEngagementDate(canonical, guestId, dateKey, "Meeting with Swamiji");
    const id = clean(payload.meetingId, 100) || uuid();
    const reference = doc(db, "meetings", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists()) assertVersion(snapshot.data(), payload.version);
      const existing = snapshot.exists() ? snapshot.data() : null;
      transaction.set(reference, {
        guestId,
        startAt: timestampFromInput(dateKey, clean(payload.time, 20), false),
        dateKey,
        timeConfirmed: Boolean(payload.time),
        status: existing?.status || "Scheduled",
        notes: clean(payload.notes),
        order: Number(existing?.order) || 1,
        createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
        updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
      });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "meeting", id, existing ? "update" : "create", ["startAt", "notes"]));
    });
    invalidate();
    return { meetingId: id, version: await committedVersion("meetings", id) };
  }

  async function setMeetingStatus(meetingId, status, suppliedVersion) {
    if (!["Scheduled", "Completed", "Cancelled"].includes(status)) throw new Error("Invalid meeting status.");
    const result = await simpleTransaction("meetings", clean(meetingId, 100), suppliedVersion, () => ({ status }), "set-status", ["status"]);
    return { meetingId: result.id, status, version: result.version };
  }

  async function saveSevaTeam(payload) {
    const actor = ensureApproved();
    const id = clean(payload?.teamId, 100) || uuid();
    const name = clean(payload?.name);
    const startDateKey = clean(payload?.startDate, 20);
    const endDateKey = clean(payload?.endDate, 20);
    if (!name) throw new Error("Event/Programme name is required.");
    if (startDateKey && endDateKey && endDateKey < startDateKey) throw new Error("End date cannot be earlier than start date.");
    const reference = doc(db, "sevaTeams", id);
    const existing = (await getDoc(reference)).data() || null;
    await setDoc(reference, {
      eventProgrammeName: name,
      startAt: timestampFromInput(startDateKey, "", false), startDateKey,
      endAt: timestampFromInput(endDateKey, "", true), endDateKey,
      calendarStartAt: timestampFromInput(startDateKey, "", false),
      calendarEndAt: timestampFromInput(endDateKey, "", true),
      createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
      updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await setDoc(doc(collection(db, "auditLogs")), auditEntry(actor, "sevaTeam", id, existing ? "update" : "create", ["name", "dates"]));
    invalidate();
    return { teamId: id, version: await committedVersion("sevaTeams", id) };
  }

  async function deleteSevaTeam(teamId) {
    const actor = ensureApproved();
    const id = clean(teamId, 100);
    const memberships = await getDocs(query(collection(db, "teamMemberships"), where("teamId", "==", id), limit(1)));
    if (!memberships.empty) throw new Error("This Seva Team still has members. Remove their memberships before deleting the team.");
    const reference = doc(db, "sevaTeams", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This Seva Team no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "sevaTeam", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { teamId: id, deleted: true };
  }

  async function addTeamMember(guestId, teamId) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const guest = canonical.guests.find(item => item.id === clean(guestId, 100) && !item.archived);
    const team = canonical.sevaTeams.find(item => item.id === clean(teamId, 100));
    if (!guest || !team) throw new Error("The guest or Seva Team no longer exists.");
    if (!TEAM_ELIGIBLE_TYPES.has(guest.personType)) throw new Error("Invited Guests and Event Staff cannot be members of a Seva Team.");
    const existing = canonical.teamMemberships.find(item => item.guestId === guest.id && item.teamId === team.id);
    if (existing) return { membershipId: existing.id, guestId: guest.id, teamId: team.id };
    const id = `${team.id}--${guest.id}`;
    const batch = writeBatch(db);
    batch.set(doc(db, "teamMemberships", id), {
      guestId: guest.id, teamId: team.id, order: (canonical.teamMemberships.filter(item => item.teamId === team.id).length + 1),
      createdAt: serverTimestamp(), createdBy: actor, updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await writeAuditBatch(batch, actor, "teamMembership", id, "create", ["guestId", "teamId"]);
    await batch.commit();
    invalidate();
    return { membershipId: id, guestId: guest.id, teamId: team.id };
  }

  async function removeTeamMember(membershipId) {
    const actor = ensureApproved();
    const id = clean(membershipId, 220);
    const reference = doc(db, "teamMemberships", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This membership no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "teamMembership", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { membershipId: id, deleted: true };
  }

  async function upsertSpecificSeva(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const guestId = clean(payload?.guestId, 100);
    const description = clean(payload?.description);
    const startDateKey = clean(payload?.startDate, 20);
    const endDateKey = clean(payload?.endDate, 20);
    if (!canonical.guests.some(item => item.id === guestId && !item.archived)) throw new Error("This guest no longer exists.");
    if (!description) throw new Error("A description is required.");
    if (startDateKey && endDateKey && endDateKey < startDateKey) throw new Error("End date cannot be earlier than start date.");
    validateEngagementDate(canonical, guestId, startDateKey, `Seva: ${description}`);
    const id = clean(payload.sevaId, 100) || uuid();
    const reference = doc(db, "specificSeva", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists()) assertVersion(snapshot.data(), payload.version);
      const existing = snapshot.exists() ? snapshot.data() : null;
      const startAt = timestampFromInput(startDateKey, "", false), endAt = timestampFromInput(endDateKey, "", true);
      transaction.set(reference, {
        guestId, description, startAt, startDateKey, endAt, endDateKey,
        hasDates: Boolean(startAt || endAt), calendarStartAt: startAt || endAt, calendarEndAt: endAt || startAt,
        order: Number(existing?.order) || (canonical.specificSeva.filter(item => item.guestId === guestId).length + 1),
        createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
        updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
      });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "specificSeva", id, existing ? "update" : "create", ["description", "dates"]));
    });
    invalidate();
    return { sevaId: id, guestId, version: await committedVersion("specificSeva", id) };
  }

  async function deleteSpecificSeva(sevaId) {
    const actor = ensureApproved();
    const id = clean(sevaId, 100);
    const reference = doc(db, "specificSeva", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This task no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "specificSeva", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { sevaId: id, deleted: true };
  }

  async function saveTrip(payload) {
    const actor = ensureApproved();
    const id = clean(payload?.tripId, 100) || uuid();
    const name = clean(payload?.name);
    const startDateKey = clean(payload?.startDate, 20);
    const endDateKey = clean(payload?.endDate, 20);
    if (!name) throw new Error("Trip name is required.");
    if (startDateKey && endDateKey && endDateKey < startDateKey) throw new Error("End date cannot be earlier than start date.");
    const reference = doc(db, "trips", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists()) assertVersion(snapshot.data(), payload.version);
      const existing = snapshot.exists() ? snapshot.data() : null;
      const cancelled = Boolean(payload.cancelled);
      const startAt = timestampFromInput(startDateKey, "", false), endAt = timestampFromInput(endDateKey, "", true);
      transaction.set(reference, {
        name, purpose: clean(payload.purpose), startAt, startDateKey, endAt, endDateKey,
        calendarStartAt: startAt, calendarEndAt: endAt,
        isCancelled: cancelled,
        cancelledAt: cancelled ? (existing?.isCancelled ? existing.cancelledAt : serverTimestamp()) : null,
        notes: clean(payload.notes),
        createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
        updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
      });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "trip", id, existing ? "update" : "create", ["name", "dates", "cancelled"]));
    });
    invalidate();
    return { tripId: id, version: await committedVersion("trips", id) };
  }

  async function addTripParticipant(tripId, guestId) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const trip = canonical.trips.find(item => item.id === clean(tripId, 100));
    const guest = canonical.guests.find(item => item.id === clean(guestId, 100) && !item.archived);
    if (!trip || !guest) throw new Error("The trip or guest no longer exists.");
    const existing = canonical.tripParticipants.find(item => item.tripId === trip.id && item.guestId === guest.id);
    if (existing) return { participantId: existing.id, tripId: trip.id, guestId: guest.id };
    const tripDates = [trip.startDateKey, trip.endDateKey].filter(Boolean);
    validateEngagementDate(canonical, guest.id, tripDates, `Trip: ${trip.name}`);
    const id = `${trip.id}--${guest.id}`;
    const batch = writeBatch(db);
    batch.set(doc(db, "tripParticipants", id), {
      tripId: trip.id, guestId: guest.id,
      createdAt: serverTimestamp(), createdBy: actor, updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await writeAuditBatch(batch, actor, "tripParticipant", id, "create", ["tripId", "guestId"]);
    await batch.commit();
    invalidate();
    return { participantId: id, tripId: trip.id, guestId: guest.id };
  }

  async function removeTripParticipant(participantId) {
    const actor = ensureApproved();
    const id = clean(participantId, 220);
    const reference = doc(db, "tripParticipants", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This participant no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "tripParticipant", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { participantId: id, deleted: true };
  }

  async function upsertTripTravelLeg(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const tripId = clean(payload?.tripId, 100);
    if (!canonical.trips.some(item => item.id === tripId)) throw new Error("This trip no longer exists.");
    const id = clean(payload.legId, 100) || uuid();
    const reference = doc(db, "tripTravelLegs", id);
    const existing = (await getDoc(reference)).data() || null;
    const travelDateKey = clean(payload.travelDate, 20);
    await setDoc(reference, {
      tripId,
      direction: clean(payload.direction, 100) || "Inbound",
      transportType: clean(payload.transportType, 100) || "Other",
      from: clean(payload.from), to: clean(payload.to),
      travelAt: timestampFromInput(travelDateKey, clean(payload.travelTime, 20), false),
      travelDateKey, timeConfirmed: Boolean(payload.travelTime),
      status: clean(payload.status, 100) || "Required", serviceNumber: clean(payload.serviceNumber),
      bookingReference: clean(payload.bookingReference), notes: clean(payload.notes),
      order: Math.max(1, Number(payload.order) || 1),
      createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
      updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await setDoc(doc(collection(db, "auditLogs")), auditEntry(actor, "tripTravelLeg", id, existing ? "update" : "create", ["itinerary"]));
    invalidate();
    return { legId: id, tripId, version: await committedVersion("tripTravelLegs", id) };
  }

  async function deleteTripTravelLeg(legId) {
    const actor = ensureApproved();
    const id = clean(legId, 100);
    const reference = doc(db, "tripTravelLegs", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This travel leg no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "tripTravelLeg", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { legId: id, deleted: true };
  }

  async function apiCall(action, extra = {}) {
    ensureApproved();
    try {
      if (action === "getBootstrap") return bootstrap();
      if (action === "getDirectorySnapshot") return directorySnapshot(extra.options || {});
      if (action === "getHomeSummary") {
        const canonical = await loadCanonical();
        return homeSummary(canonical, buildDirectoryRecords(canonical, false));
      }
      if (action === "getDirectory") {
        const options = extra.options || {};
        const canonical = await loadCanonical();
        const term = clean(options.nameQuery, 200).toLowerCase();
        const includeArchived = Boolean(options.includeArchived);
        const rows = canonical.guests.filter(item => (includeArchived || !item.archived) && (!term || String(item.name || "").toLowerCase().includes(term)))
          .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
          .map(item => ({
            guestId: item.id, name: item.name || "", personType: item.personType || "Needs Review",
            isForeign: Boolean(item.foreignNational), invitedPurpose: item.invitedPurposes || [],
            invitedPurposeOther: item.invitedPurposeOther || "", staffAssignment: item.staffAssignment || "",
            archived: Boolean(item.archived), version: versionOf(item)
          }));
        const offset = Math.max(0, Number(options.offset) || 0);
        const limitValue = Math.min(200, Math.max(1, Number(options.limit) || 50));
        return { guests: rows.slice(offset, offset + limitValue), total: rows.length, offset, limit: limitValue };
      }
      if (action === "getGuestProfile") return guestProfile(extra.guestId);
      if (action === "getWorkspaceData") return workspaceData(extra.workspace, extra.filters || {});
      if (action === "createSession") return { sessionToken: "firebase-auth-persistence" };
      if (action === "createGuest") return createGuest(extra.payload || {});
      if (action === "updateGuestBasics") return updateGuestBasics(extra.payload || {});
      if (action === "archiveGuest") return setGuestArchived(extra.guestId, extra.version, true);
      if (action === "restoreGuest") return setGuestArchived(extra.guestId, extra.version, false);
      if (action === "deleteGuest") return deleteGuestRecord(extra.guestId, extra.version);
      if (action === "saveVisitPlan") return saveVisitPlan(extra.payload || {});
      if (action === "cancelVisit") return setVisitCancelled(extra.visitId, extra.version, true);
      if (action === "restoreVisit") return setVisitCancelled(extra.visitId, extra.version, false);
      if (action === "upsertMealOverride") return upsertMealOverride(extra.payload || {});
      if (action === "upsertMeeting") return upsertMeeting(extra.payload || {});
      if (action === "setMeetingStatus") return setMeetingStatus(extra.meetingId, extra.status, extra.version);
      if (action === "saveSevaTeam") return saveSevaTeam(extra.payload || {});
      if (action === "deleteSevaTeam") return deleteSevaTeam(extra.teamId);
      if (action === "addTeamMember") return addTeamMember(extra.guestId, extra.teamId);
      if (action === "removeTeamMember") return removeTeamMember(extra.membershipId);
      if (action === "upsertSpecificSeva") return upsertSpecificSeva(extra.payload || {});
      if (action === "deleteSpecificSeva") return deleteSpecificSeva(extra.sevaId);
      if (action === "saveTrip") return saveTrip(extra.payload || {});
      if (action === "addTripParticipant") return addTripParticipant(extra.tripId, extra.guestId);
      if (action === "removeTripParticipant") return removeTripParticipant(extra.participantId);
      if (action === "upsertTripTravelLeg") return upsertTripTravelLeg(extra.payload || {});
      if (action === "deleteTripTravelLeg") return deleteTripTravelLeg(extra.legId);
      if (action === "savePushSubscription" || action === "removePushSubscription") {
        throw new Error("Push subscription changes are not enabled in this Firestore version.");
      }
      throw new Error(`Unknown action: ${action}`);
    } catch (error) {
      if (error?.code === "permission-denied") throw accessError("Access denied for this Google account.");
      if (["unauthenticated", "auth/user-token-expired"].includes(error?.code)) throw authError("Your session expired. Please sign in again.");
      throw error;
    }
  }

  function startRemoteListener(callback) {
    if (remoteUnsubscribe) return remoteUnsubscribe;
    const latestAudit = query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(1));
    remoteUnsubscribe = onSnapshot(latestAudit, snapshot => {
      if (!initialAuditSnapshotSeen) { initialAuditSnapshotSeen = true; return; }
      if (snapshot.empty) return;
      invalidate();
      callback?.(snapshot.docs[0].data());
    }, error => console.warn("Realtime change listener paused:", error));
    return remoteUnsubscribe;
  }

  return {
    auth,
    apiCall,
    signIn: () => signInWithPopup(auth, provider),
    signOut: () => signOut(auth),
    onAuthStateChanged: callback => onAuthStateChanged(auth, callback),
    isApproved: user => Boolean(user && APPROVED_EMAILS.has(clean(user.email, 200).toLowerCase())),
    startRemoteListener,
    hasCanonicalCache: () => Boolean(canonicalCache),
    invalidate
  };
}
