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
// Permanent Resident is a person who lives here rather than one passing
// through. It is a Person Type like any other so that residents can hold an
// ordinary guest record and reach seva, meetings and trips — all of which are
// keyed on guestId and are therefore closed to them otherwise.
const PERSON_TYPES = new Set(["Invited Guest", "Friend", "Visitor", "Event Staff", "Other", "Permanent Resident"]);
// Residents are eligible for Seva Teams: the exclusion here is about guests
// whose time is already committed, which is not true of someone who lives here.
const TEAM_ELIGIBLE_TYPES = new Set(["Friend", "Visitor", "Other", "Permanent Resident"]);
const MEALS = ["Breakfast", "Lunch", "Dinner"];
const MEAL_SEATING = new Set(["Floor", "Table and chair"]);
const MEAL_SOURCE_TYPES = new Set(["individualGuest", "sevaTeam", "individualSeva"]);
const MEAL_RECURRENCES = new Set(["oneTime", "daily", "weekly"]);
// NONE is deliberately outside the four tabs. A guest who has only just been
// entered has no visit and no engagements — nothing today, nothing upcoming,
// and emphatically nothing past. Sorting them into Past (which is what falling
// through to it did) told the office a brand-new record was finished business.
// They belong under All Guests until something is actually scheduled for them.
const DIRECTORY_TIER = { PRIORITY: 1, TODAY: 2, UPCOMING: 3, PAST: 4, NONE: 5, RESIDENT: 6 };
const DIRECTORY_TIER_LABEL = { 1: "Priority", 2: "Today", 3: "Upcoming", 4: "Past", 5: "No activity", 6: "Resident" };

// Someone who lives here, expressed as an ordinary guest with an ashram stay
// that has no beginning and no end. Everything that would otherwise treat a
// dateless stay as an unfinished one asks this first. Written as one predicate
// so the rule lives in a single place rather than as a person-type check
// scattered through the read paths.
// A resident's quarters are not a visit room — they are inventory taken out
// of circulation, carrying the occupant's name. Matched on a normalised name
// because that is the only link the rooms data has to a person.
function permanentRoomsFor(canonical, name) {
  const key = clean(name, 200).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key) return [];
  return (canonical.rooms || [])
    .filter(room => (room.permanent || clean(room.category, 100).toLowerCase() === "permanent")
      && clean(room.occupant, 200).toLowerCase().replace(/[^a-z0-9]/g, "") === key)
    .map(room => room.displayName || (clean(room.building, 100) + " - " + clean(room.room, 100)))
    .sort((a, b) => a.localeCompare(b));
}

function isResidencyStay(visit, personType) {
  return Boolean(visit) && personType === "Permanent Resident" && visit.accommodation === "Ashram";
}
const COLLECTIONS = [
  "guests", "visits", "visitRooms", "visitTravelLegs", "rooms", "mealOverrides",
  "mealSchedules", "mealSeatingChanges", "mealAbsences", "permanentResidents",
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

function mealSeating(value, fallback = "Floor") {
  const seating = clean(value, 40);
  return MEAL_SEATING.has(seating) ? seating : fallback;
}

// Which meals a stay covers. All three unless the residency plan says less;
// an empty or unrecognised list means nobody chose, not "no meals".
function residencyMeals(visit) {
  const chosen = Array.isArray(visit?.residencyMeals)
    ? visit.residencyMeals.filter(meal => MEALS.includes(meal))
    : [];
  return chosen.length ? chosen : MEALS;
}

// The same rule for someone who lives here rather than visiting.
function residentMeals(resident) {
  const chosen = Array.isArray(resident?.meals)
    ? resident.meals.filter(meal => MEALS.includes(meal))
    : [];
  return chosen.length ? chosen : MEALS;
}

// A seating change made in the Meals workspace takes effect from its own date
// onward and leaves earlier days exactly as they were — which is why it is a
// dated record rather than a field on the guest. Writing one supersedes any
// later change for the same person (see setMealSeatingFrom), so "from here on,
// until changed again" stays literally true however many changes accumulate.
// A guest away for a few days keeps their room, their stay and their standing
// meal arrangement — they are simply not eating here meanwhile. One record per
// absence, so it reads back as a single fact and can be undone as one.
function absenceOn(absences, subjectType, subjectId, dateKey) {
  return (absences || []).find(item =>
    item.subjectType === subjectType
    && item.subjectId === subjectId
    && clean(item.fromKey, 20)
    && clean(item.fromKey, 20) <= dateKey
    && (!clean(item.toKey, 20) || clean(item.toKey, 20) >= dateKey)) || null;
}

function seatingChangeOn(changes, subjectType, subjectId, dateKey) {
  let best = null;
  (changes || []).forEach(item => {
    if (item.subjectType !== subjectType || item.subjectId !== subjectId) return;
    const from = clean(item.fromKey, 20);
    if (!from || from > dateKey) return;
    if (!best || from > clean(best.fromKey, 20)) best = item;
  });
  return best ? mealSeating(best.seating) : "";
}

function weekdayOfDateKey(dateKey) {
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? -1 : parsed.getUTCDay();
}

function dateInside(dateKey, startDateKey, endDateKey) {
  return Boolean(dateKey)
    && (!startDateKey || dateKey >= startDateKey)
    && (!endDateKey || dateKey <= endDateKey);
}

function mealScheduleMatchesDate(schedule, dateKey) {
  if (schedule.active === false) return false;
  const recurrence = MEAL_RECURRENCES.has(schedule.recurrence) ? schedule.recurrence : "oneTime";
  if (recurrence === "oneTime") return schedule.dateKey === dateKey;
  if (!dateInside(dateKey, schedule.startDateKey || "", schedule.endDateKey || "")) return false;
  if (recurrence === "daily") return true;
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays.map(Number) : [];
  return weekdays.includes(weekdayOfDateKey(dateKey));
}

function mealScheduleView(schedule, canonical) {
  const guestsById = Object.fromEntries(canonical.guests.map(item => [item.id, item]));
  const teamsById = Object.fromEntries(canonical.sevaTeams.map(item => [item.id, item]));
  const tasksById = Object.fromEntries(canonical.specificSeva.map(item => [item.id, item]));
  let name = "Unknown source", guestId = "", personType = "";
  if (schedule.sourceType === "individualGuest") {
    const guest = guestsById[schedule.sourceId];
    name = guest?.name || "Missing guest";
    guestId = guest?.id || schedule.sourceId || "";
    personType = guest?.personType || "";
  } else if (schedule.sourceType === "sevaTeam") {
    name = teamsById[schedule.sourceId]?.eventProgrammeName || "Missing Seva Team";
  } else if (schedule.sourceType === "individualSeva") {
    const task = tasksById[schedule.sourceId];
    const guest = task ? guestsById[task.guestId] : null;
    name = `${guest?.name || "Missing guest"} · ${task?.description || "Individual seva"}`;
    guestId = guest?.id || "";
    personType = guest?.personType || "";
  }
  return {
    scheduleId: schedule.id,
    sourceType: schedule.sourceType || "individualGuest",
    sourceId: schedule.sourceId || "",
    name,
    guestId,
    personType,
    recurrence: schedule.recurrence || "oneTime",
    date: schedule.dateKey || "",
    weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays.map(Number) : [],
    startDate: schedule.startDateKey || "",
    endDate: schedule.endDateKey || "",
    meals: Array.isArray(schedule.meals) ? schedule.meals.filter(meal => MEALS.includes(meal)) : [],
    defaultSeating: mealSeating(schedule.defaultSeating),
    note: schedule.note || "",
    active: schedule.active !== false,
    version: versionOf(schedule)
  };
}

// Resolve, rather than materialize, a day's meal roster. Standing rules stay
// compact in Firestore while this one function supplies both the Meals page
// and the homepage totals, so the two views cannot drift apart.
function resolveMealDay(canonical, dateKey) {
  const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
  const residentsById = Object.fromEntries(canonical.permanentResidents.map(item => [item.id, item]));
  const teamsById = Object.fromEntries(canonical.sevaTeams.map(item => [item.id, item]));
  const tasksById = Object.fromEntries(canonical.specificSeva.map(item => [item.id, item]));
  const membersByTeam = groupBy(canonical.teamMemberships, "teamId");
  const candidates = new Map();

  function subjectRecord(subjectType, subjectId) {
    if (subjectType === "permanentResident") {
      const resident = residentsById[subjectId];
      return resident ? { name: resident.name || "Unnamed resident", personType: "Permanent Resident", guestId: resident.guestId || "" } : null;
    }
    const guest = guestsById[subjectId];
    return guest ? { name: guest.name || "Unnamed Guest", personType: guest.personType || "Needs Review", guestId: guest.id } : null;
  }

  function ensureCandidate(subjectType, subjectId) {
    const key = `${subjectType}:${subjectId}`;
    if (candidates.has(key)) return candidates.get(key);
    const subject = subjectRecord(subjectType, subjectId);
    if (!subject) return null;
    const candidate = {
      key, subjectType, subjectId, guestId: subject.guestId,
      name: subject.name, personType: subject.personType,
      resident: false, mealSources: {}, mealSeating: {}
    };
    MEALS.forEach(meal => { candidate.mealSources[meal] = []; });
    candidates.set(key, candidate);
    return candidate;
  }

  function addSource(subjectType, subjectId, meals, source, seating = "Floor", resident = false) {
    const candidate = ensureCandidate(subjectType, subjectId);
    if (!candidate) return;
    candidate.resident = candidate.resident || resident;
    meals.forEach(meal => {
      if (!MEALS.includes(meal)) return;
      if (!candidate.mealSources[meal].some(item => item.type === source.type && item.id === source.id)) {
        candidate.mealSources[meal].push(source);
      }
      // Explicit arrangements take precedence over a resident default; an
      // individual invitation takes precedence over team-derived seating.
      const priority = { residence: 0, sevaTeam: 1, individualSeva: 2, individualGuest: 3 };
      const current = candidate.mealSeating[meal];
      if (!current || (priority[source.type] || 0) >= (priority[current.sourceType] || 0)) {
        candidate.mealSeating[meal] = { value: mealSeating(seating), sourceType: source.type };
      }
    });
  }

  // Skipped once the same person exists as a guest, so the two sources can
  // never both feed the roster. This switches per person as the migration
  // lands, which is what keeps a partial migration correct.
  const migratedResidentIds = new Set(canonical.guests
    .map(item => item.migratedFromResidentId).filter(Boolean));
  canonical.permanentResidents
    .filter(item => !migratedResidentIds.has(item.id)
      && item.active !== false && dateInside(dateKey, item.activeFromKey || "", item.activeUntilKey || ""))
    .forEach(item => addSource(
      "permanentResident", item.id, residentMeals(item),
      { type: "residence", id: item.id, label: "Permanent resident" },
      item.defaultSeating, true
    ));

  canonical.visits
    .filter(item => {
      if (item.isCancelled || item.accommodation !== "Ashram") return false;
      // A residency has no arrival date to fall inside, so it counts for every
      // day; an ordinary stay still has to contain the date.
      if (isResidencyStay(item, guestsById[item.guestId]?.personType)) {
        return dateInside(dateKey, item.arrivalDateKey || "", item.departureDateKey || "");
      }
      return Boolean(item.arrivalDateKey)
        && dateInside(dateKey, item.arrivalDateKey, item.departureDateKey || "");
    })
    // A guest housed here is put on the roster by residence alone — which
    // meals, and the seating they start from, are both properties of the stay.
    .forEach(item => addSource(
      "guest", item.guestId, residencyMeals(item),
      // Living here and staying here are both residence, but they are not the
      // same fact, so the roster names them differently.
      { type: "residence", id: item.id,
        label: isResidencyStay(item, guestsById[item.guestId]?.personType)
          ? "Permanent resident" : "Staying in the ashram" },
      mealSeating(item.diningSeating), true
    ));

  canonical.mealSchedules.filter(schedule => mealScheduleMatchesDate(schedule, dateKey)).forEach(schedule => {
    const meals = Array.isArray(schedule.meals) ? schedule.meals : [];
    const seating = mealSeating(schedule.defaultSeating);
    if (schedule.sourceType === "individualGuest") {
      const guest = guestsById[schedule.sourceId];
      if (guest) addSource("guest", guest.id, meals, { type: "individualGuest", id: schedule.id, label: "Individual invitation" }, seating);
      return;
    }
    if (schedule.sourceType === "sevaTeam") {
      const team = teamsById[schedule.sourceId];
      if (!team || !dateInside(dateKey, team.startDateKey || "", team.endDateKey || "")) return;
      (membersByTeam[team.id] || []).forEach(member => addSource(
        "guest", member.guestId, meals,
        { type: "sevaTeam", id: schedule.id, label: `Seva Team: ${team.eventProgrammeName || "Unnamed team"}` },
        seating
      ));
      return;
    }
    if (schedule.sourceType === "individualSeva") {
      const task = tasksById[schedule.sourceId];
      if (!task || !dateInside(dateKey, task.startDateKey || "", task.endDateKey || "")) return;
      addSource(
        "guest", task.guestId, meals,
        { type: "individualSeva", id: schedule.id, label: `Individual seva: ${task.description || "Seva"}` },
        seating
      );
    }
  });

  const overrides = canonical.mealOverrides.filter(item => item.dateKey === dateKey && MEALS.includes(item.meal));
  const overrideMap = new Map();
  overrides.forEach(item => {
    const subjectType = item.subjectType === "permanentResident" ? "permanentResident" : "guest";
    const subjectId = item.subjectId || item.guestId || "";
    if (!subjectId) return;
    const key = `${subjectType}:${subjectId}:${item.meal}`;
    overrideMap.set(key, item);
    if (item.included) ensureCandidate(subjectType, subjectId);
  });

  const rosters = Object.fromEntries(MEALS.map(meal => [meal, []]));
  const notAttending = Object.fromEntries(MEALS.map(meal => [meal, []]));
  const mealStats = Object.fromEntries(MEALS.map(meal => [meal, { total: 0, floor: 0, tableAndChair: 0, absent: 0 }]));
  const counts = { Breakfast: 0, Lunch: 0, Dinner: 0 };
  let exceptionCount = 0;

  candidates.forEach(candidate => {
    MEALS.forEach(meal => {
      const sources = candidate.mealSources[meal] || [];
      const override = overrideMap.get(`${candidate.subjectType}:${candidate.subjectId}:${meal}`);
      const expected = sources.length > 0;
      if (!expected && !override?.included) return;
      // Being away drops them from the meal without touching why they were on
      // the roster — so they still appear, under Not attending, one tap from
      // being added back. A single-day override outranks the period, which is
      // how a guest who does turn up for one lunch gets recorded.
      const away = absenceOn(canonical.mealAbsences, candidate.subjectType, candidate.subjectId, dateKey);
      const included = override ? Boolean(override.included) : (expected && !away);
      // Three layers, narrowest last: whatever put them on the roster decides
      // the base seating; a dated change in the Meals workspace supersedes it
      // from its own date on; a single-day override still beats both.
      const standing = seatingChangeOn(canonical.mealSeatingChanges, candidate.subjectType, candidate.subjectId, dateKey);
      const defaultSeating = standing || candidate.mealSeating[meal]?.value || "Floor";
      const seating = mealSeating(override?.seatingOverride, defaultSeating);
      const row = {
        subjectType: candidate.subjectType,
        subjectId: candidate.subjectId,
        guestId: candidate.guestId,
        name: candidate.name,
        personType: candidate.personType,
        isResident: candidate.resident,
        included,
        seating,
        defaultSeating,
        note: override?.note || "",
        sources,
        away: Boolean(away),
        awayFrom: away ? clean(away.fromKey, 20) : "",
        awayTo: away ? clean(away.toKey, 20) : "",
        awayNote: away ? clean(away.note, 300) : "",
        overrideId: override?.id || null,
        isException: Boolean(override),
        version: override ? versionOf(override) : 0
      };
      if (override) exceptionCount += 1;
      if (included) {
        rosters[meal].push(row);
        counts[meal] += 1;
        mealStats[meal].total += 1;
        if (seating === "Table and chair") mealStats[meal].tableAndChair += 1;
        else mealStats[meal].floor += 1;
      } else {
        notAttending[meal].push(row);
        mealStats[meal].absent += 1;
      }
    });
  });

  MEALS.forEach(meal => {
    rosters[meal].sort((a, b) => a.name.localeCompare(b.name));
    notAttending[meal].sort((a, b) => a.name.localeCompare(b.name));
  });
  return {
    date: dateKey,
    counts,
    mealStats,
    rosters,
    notAttending,
    residentCount: [...candidates.values()].filter(item => item.resident).length,
    exceptionCount
  };
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
  const roomRows = (roomsByVisit[visit.id] || []).sort((a, b) => (a.order || 0) - (b.order || 0));
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
    // "" when nothing was recorded — the editor needs to tell that apart from
    // a deliberate choice of Floor.
    diningSeating: visit.diningSeating || "",
    residencyQuarters: visit.residencyQuarters || "",
    // The residency meal plan is owned by the Meals workspace, not the visit
    // editor; exposed here so the editor can carry it back unchanged.
    residencyMeals: residencyMeals(visit),
    residencyMealNote: visit.residencyMealNote || "",
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
    rooms: roomRows.map(row => row.roomLabelSnapshot),
    roomAllocations: roomRows.map(row => ({
      room: row.roomLabelSnapshot,
      sharedOk: Boolean(row.sharedOk)
    })),
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
  // A residency has no arrival to record and keeps its room on the rooms
  // collection, so neither of these is a missing detail for a resident.
  const residency = isResidencyStay(visit, record.personType);
  if (!visit.arrivalDate && !residency) reasons.push("Arrival date not set");
  if (visit.accommodation === "TBD") reasons.push("Accommodation not decided");
  if (visit.accommodation === "Outside - Arranged by Ashram" && !visit.outsideAccommodationConfirmed) reasons.push("Outside accommodation not confirmed");
  if (visit.accommodation === "Ashram" && !visit.rooms.length && !residency) reasons.push("Room missing");
  // The C-form registers a foreign national staying on the premises, so it
  // only applies once they are actually here and only when the ashram itself
  // is housing them — not for a guest the ashram booked into a hotel.
  if (record.isForeign && !visit.cformComplete && visit.accommodation === "Ashram"
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

// Note: priorityReasons are deliberately NOT consulted here any more. They
// used to short-circuit to a Priority tier, which meant a guest arriving today
// with an unassigned room vanished from Today. Reasons still drive the card
// badges, the search index and the homepage attention counts — they just no
// longer decide which tab a guest appears under.
function directoryTier(record, reasons, todayKey) {
  const visit = record.visit;
  // Decided before anything else, and from the person rather than the stay:
  // being a resident is a fact about who they are, where the stay is only how
  // their meals are arranged. Keying it off the stay meant someone newly marked
  // a resident sat in No activity until a stay existed — while the Meals tab,
  // which asks the person, already listed them. The two now agree.
  if (record.personType === "Permanent Resident") return DIRECTORY_TIER.RESIDENT;
  const happensToday = (visit && [visit.arrivalDate, visit.departureDate].includes(todayKey))
    || (record.mealsToday || []).length
    || (record.upcomingMeetings || []).some(item => item.status === "Scheduled" && item.date === todayKey);
  if (happensToday) return DIRECTORY_TIER.TODAY;
  const future = (visit && ((!visit.arrivalDate && !visit.departureDate) || !visit.departureDate || visit.arrivalDate > todayKey || visit.departureDate > todayKey))
    || (record.upcomingMeetings || []).some(item => item.status === "Scheduled" && item.date > todayKey)
    || (record.specificSeva || []).some(item => !item.endDate || item.endDate >= todayKey)
    || (record.sevaTeams || []).some(item => item.status !== "Seva completed")
    || (record.trips || []).some(item => ["Active", "Upcoming"].includes(item.status));
  if (future) return DIRECTORY_TIER.UPCOMING;
  // Past has to mean "something happened and is over", not merely "nothing is
  // coming up". A record with no visit and no engagement of any kind has no
  // history to be in the past of.
  const hasAnyHistory = Boolean(record.visit)
    || (record.visits || []).length
    || (record.mealOverrides || record.meals || []).length
    || (record.meetings || []).length
    || (record.specificSeva || []).length
    || (record.sevaTeams || []).length
    || (record.trips || []).length;
  return hasAnyHistory ? DIRECTORY_TIER.PAST : DIRECTORY_TIER.NONE;
}

function tierCounts(records) {
  const counts = { priority: 0, today: 0, upcoming: 0, past: 0, all: records.length };
  records.forEach(record => {
    if (record.tier === 1) counts.priority += 1;
    else if (record.tier === 2) counts.today += 1;
    else if (record.tier === 3) counts.upcoming += 1;
    // Only a real Past record counts as Past; a guest with no activity at all
    // is reachable through All Guests and shouldn't inflate the Past tab.
    else if (record.tier === 4) counts.past += 1;
  });
  return counts;
}

function roomInventory(canonical) {
  // Permanent resident rooms are not operational guest inventory. Excluding
  // them here keeps them out of every picker and also makes the save path
  // reject a forged/manual attempt to assign one to a visit.
  return canonical.rooms.filter(room => room.active !== false
    && !room.permanent
    && clean(room.category, 100).toLowerCase() !== "permanent").map(room => ({
    roomId: room.id,
    building: room.building,
    room: room.room,
    category: room.category || "Normal",
    permanent: Boolean(room.permanent),
    occupant: room.occupant || "",
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
      // Every dated stay, not just the current one, so the client can warn
      // about a date landing outside them while it is being picked. A guest
      // with two visits has two windows and a gap between them that no single
      // min/max range could express — hence a list, matching the same shape
      // validateEngagementDate enforces on save.
      stayWindows: stayWindows(allVisits),
      sevaTeams: teams,
      specificSeva: tasks,
      mealsToday: meals.filter(item => item.date === todayKey),
      upcomingMeetings: meetings.filter(item => item.status === "Scheduled"),
      nextMeeting: meetings.filter(item => item.status === "Scheduled" && item.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date))[0] || null,
      trips
    };
    // The Directory card reads rooms off the current visit, which a residency
    // does not carry — so the quarters go on it here, the same as in
    // Accommodation & Travel.
    if (record.visit && isResidencyStay(record.visit, record.personType) && !record.visit.rooms.length) {
      record.visit.rooms = record.visit.residencyQuarters
        ? [record.visit.residencyQuarters]
        : permanentRoomsFor(canonical, record.name);
    }
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
  const todayMeals = resolveMealDay(canonical, today);
  const result = {
    generatedAt: Date.now(),
    directory: { total: records.length, needsAttention: 0 },
    accommodation: { today: 0, upcoming: 0, arrivingToday: 0, departingToday: 0, currentlyResiding: 0, attentionNeeded: 0 },
    meals: {
      counts: todayMeals.counts,
      mealStats: todayMeals.mealStats,
      residentCount: todayMeals.residentCount,
      exceptionCount: todayMeals.exceptionCount
    },
    meetings: { today: 0, upcoming: 0, needsCompletion: 0 },
    seva: { activeTeams: 0, activeTeamMembers: 0, activeSpecificSeva: 0, startingSoon: 0 },
    trips: { active: 0, upcoming: 0, needingTravel: 0 }
  };
  // Counted over every live visit, not one per guest. A record exposes only
  // its current-or-nearest visit, so counting from records undercounted any
  // guest with more than one visit booked — and the homepage tile has to agree
  // with the workspace, which lists them all. The two tests below are the same
  // ones ACCOMMODATION_SECTIONS_ uses for its Today and Upcoming tabs.
  canonical.visits.filter(visit => !visit.isCancelled).forEach(visit => {
    const arrival = visit.arrivalDateKey || "";
    const departure = visit.departureDateKey || "";
    if (arrival === today || departure === today) result.accommodation.today += 1;
    if (arrival && arrival > today) result.accommodation.upcoming += 1;
  });

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
      overrideId: item.id, date: item.dateKey, meal: item.meal, included: Boolean(item.included),
      seating: item.seatingOverride || "", note: item.note || "", version: versionOf(item)
    }));
    const mealSchedules = canonical.mealSchedules
      .filter(item => item.sourceType === "individualGuest" && item.sourceId === id)
      .map(item => mealScheduleView(item, canonical));
    const meetings = canonical.meetings.filter(item => item.guestId === id).map(meetingView);
    const specificSeva = canonical.specificSeva.filter(item => item.guestId === id).map(taskView);
    const teamsById = Object.fromEntries(canonical.sevaTeams.map(item => [item.id, item]));
    const sevaTeams = canonical.teamMemberships.filter(item => item.guestId === id).map(item => teamsById[item.teamId]).filter(Boolean).map(teamView);
    const tripsById = Object.fromEntries(canonical.trips.map(item => [item.id, item]));
    const trips = canonical.tripParticipants.filter(item => item.guestId === id).map(item => {
      const trip = tripsById[item.tripId];
      return trip ? { participantId: item.id, ...tripView(trip) } : null;
    }).filter(Boolean);
    const hasHistory = visits.length || mealOverrides.length || mealSchedules.length || meetings.length || specificSeva.length || sevaTeams.length || trips.length;
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
      mealSchedules,
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
      // A residency holds no visit room, so the quarters recorded against
      // the person are supplied here instead — the card then shows a room
      // either way without having to know which kind of stay it is.
      // What someone has written for this person wins over what the rooms
      // data implies about them, since it was said deliberately and more
      // recently.
      const residencyRooms = !isResidencyStay(item, guest.personType) ? []
        : (clean(item.residencyQuarters, 200)
          ? [clean(item.residencyQuarters, 200)]
          : permanentRoomsFor(canonical, guest.name));
      return {
        ...view,
        rooms: view.rooms.length ? view.rooms : residencyRooms,
        residencyRooms,
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
    const resolved = resolveMealDay(canonical, date);
    const schedules = canonical.mealSchedules.map(item => mealScheduleView(item, canonical))
      .sort((a, b) => a.name.localeCompare(b.name));
    // The tab is a view over two sources while the migration is in flight:
    // residents still held as their own records, and residents who have become
    // guests with a standing stay. Each person appears once, from whichever
    // source is actually in force for them, so the list is complete and
    // truthful before, during and after. When the old records are gone the
    // first half is simply always empty.
    const migratedIds = new Set(canonical.guests.map(item => item.migratedFromResidentId).filter(Boolean));
    const residentsAsGuests = canonical.guests
      .filter(item => !item.archived && item.personType === "Permanent Resident")
      .map(guest => {
        const stay = canonical.visits.find(visit => visit.guestId === guest.id
          && !visit.isCancelled && visit.accommodation === "Ashram");
        return {
          source: "guest",
          residentId: "",
          guestId: guest.id,
          visitId: stay?.id || "",
          name: guest.name || "",
          defaultSeating: mealSeating(stay?.diningSeating),
          meals: residencyMeals(stay || {}),
          mealNote: stay?.residencyMealNote || "",
          activeFrom: stay?.arrivalDateKey || "",
          activeUntil: stay?.departureDateKey || "",
          active: true,
          note: "",
          version: versionOf(stay || {})
        };
      });
    const permanentResidents = canonical.permanentResidents.filter(item => !migratedIds.has(item.id)).map(item => ({
      source: "record",
      guestId: "",
      visitId: "",
      residentId: item.id,
      name: item.name || "",
      defaultSeating: mealSeating(item.defaultSeating),
      meals: residentMeals(item),
      mealNote: item.mealNote || "",
      activeFrom: item.activeFromKey || "",
      activeUntil: item.activeUntilKey || "",
      active: item.active !== false,
      note: item.note || "",
      version: versionOf(item)
    })).concat(residentsAsGuests).sort((a, b) => a.name.localeCompare(b.name));
    const teams = canonical.sevaTeams.map(item => teamView(item)).sort((a, b) => a.name.localeCompare(b.name));
    const guestsById = Object.fromEntries(canonical.guests.filter(item => !item.archived).map(item => [item.id, item]));
    const individualSeva = canonical.specificSeva.map(item => {
      const guest = guestsById[item.guestId];
      return guest ? { guestId: guest.id, name: guest.name, personType: guest.personType, ...taskView(item) } : null;
    }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    // Staying in the ashram is itself a standing meal arrangement, so the
    // editor needs the stay windows to say so instead of offering to build one
    // that already exists. Also what clamps the date pickers for everyone else.
    const residencies = canonical.visits
      .filter(item => !item.isCancelled && item.guestId && guestsById[item.guestId])
      .map(item => ({
        guestId: item.guestId,
        visitId: item.id,
        accommodation: item.accommodation || "TBD",
        from: item.arrivalDateKey || "",
        to: item.departureDateKey || "",
        meals: residencyMeals(item),
        seating: item.diningSeating || "",
        note: item.residencyMealNote || ""
      }))
      .sort((a, b) => (a.from || "").localeCompare(b.from || ""));
    return {
      ...resolved,
      schedules,
      permanentResidents,
      teams,
      individualSeva,
      residencies,
      absences: canonical.mealAbsences
        .map(item => ({
          absenceId: item.id,
          subjectType: item.subjectType === "permanentResident" ? "permanentResident" : "guest",
          subjectId: item.subjectId || "",
          from: clean(item.fromKey, 20),
          to: clean(item.toKey, 20),
          note: item.note || ""
        }))
        .sort((a, b) => a.from.localeCompare(b.from)),
      generatedAt: Date.now()
    };
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

  // Being a permanent resident means living here, so the stay that says so is
  // created with the person rather than left as a second step someone has to
  // remember. Without it they would sit in the Directory and the Meals tab but
  // never appear on a roster, and their meal plan would have nowhere to live.
  // Derived id, so this can never produce a second stay for the same guest.
  function residencyVisitData(guestId, actor) {
    return {
      guestId,
      arrivalAt: null, arrivalDateKey: "", arrivalTimeConfirmed: false,
      departureAt: null, departureDateKey: "", departureTimeConfirmed: false,
      accommodation: "Ashram",
      outsideAccommodationDetails: "", outsideAccommodationConfirmed: false,
      stayingAt: "",
      diningSeating: "",
      residencyQuarters: "",
      residencyMeals: [...MEALS],
      residencyMealNote: "",
      cFormComplete: false,
      pickupRequired: false, pickupAt: null, pickupDateKey: "", pickupTimeConfirmed: false,
      pickupFrom: "", pickupDetails: "",
      dropoffRequired: false, dropoffAt: null, dropoffDateKey: "", dropoffTimeConfirmed: false,
      dropoffTo: "", dropoffDetails: "",
      isCancelled: false, cancelledAt: null,
      hasArrivalDate: false, calendarStartAt: null, calendarEndAt: null,
      schemaVersion: 1,
      createdAt: serverTimestamp(), createdBy: actor,
      updatedAt: serverTimestamp(), updatedBy: actor
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
      if (data.personType === "Permanent Resident") {
        transaction.set(doc(db, "visits", `RES-${id}`), residencyVisitData(id, actor));
      }
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
    // Someone promoted to resident needs the stay that says they live here,
    // exactly as if they had been created as one. Checked against the whole
    // set rather than only the derived id, so a resident who arrived by
    // migration is not given a second one.
    const canonical = await loadCanonical();
    const hasAshramStay = canonical.visits.some(visit => visit.guestId === id
      && !visit.isCancelled && visit.accommodation === "Ashram");
    const wasResident = (canonical.guests.find(guest => guest.id === id) || {})
      .personType === "Permanent Resident";
    const residencyStays = canonical.visits.filter(visit => visit.guestId === id
      && !visit.isCancelled && visit.accommodation === "Ashram" && !visit.arrivalDateKey);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error("This guest no longer exists.");
      assertVersion(snapshot.data(), payload.version);
      const nextData = guestWriteData(payload, actor, snapshot.data());
      transaction.update(reference, nextData);
      if (nextData.personType === "Permanent Resident" && !hasAshramStay) {
        transaction.set(doc(db, "visits", `RES-${id}`), residencyVisitData(id, actor));
      }
      // Retyped away from resident: the standing stay says they live here,
      // which is no longer true. Cancelled rather than deleted — it keeps the
      // record and its meal plan, drops them off every roster and list, and
      // can be undone by making them a resident again. Only dateless ashram
      // stays are touched: a real visit with real dates is somebody's
      // arrangements and is never collateral in a person-type change.
      if (wasResident && nextData.personType !== "Permanent Resident") {
        residencyStays.forEach(stay => {
          transaction.update(doc(db, "visits", stay.id), {
            isCancelled: true, cancelledAt: Timestamp.now(),
            updatedAt: serverTimestamp(), updatedBy: actor
          });
        });
      }
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
      || canonical.mealSchedules.some(item => item.sourceType === "individualGuest" && item.sourceId === id)
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

  const newGuestPayload =
    payload?.newGuest && typeof payload.newGuest === "object"
      ? payload.newGuest
      : null;

  const storedGuest =
    canonical.guests.find(item => item.id === guestId) || null;

  const newGuestData = newGuestPayload
    ? guestWriteData(newGuestPayload, actor)
    : null;

  if (newGuestData) {
    if (!guestId) {
      throw new Error(
        "A Guest ID is required for a new guest and visit."
      );
    }

    if (storedGuest) {
      throw new Error("A guest with this ID already exists.");
    }

    const sameName = canonical.guests.find(
      item =>
        (
          item.nameNormalized ||
          clean(item.name).toLowerCase()
        ) === newGuestData.nameNormalized
    );

    if (sameName) {
      throw new Error(
        "A guest with this name already exists. Choose the existing guest instead."
      );
    }
  }

  const guest = newGuestData
    ? { id: guestId, ...newGuestData }
    : storedGuest;

  if (!guest || guest.archived) {
    throw new Error("This guest no longer exists.");
  }

  const visitId = clean(payload.visitId, 100) || uuid();
  const existing =
    canonical.visits.find(item => item.id === visitId) || null;

  if (existing) {
    assertVersion(existing, payload.version);
  }

  const arrivalAt = timestampFromInput(
    clean(payload.arrivalDate, 20),
    clean(payload.arrivalTime, 20),
    false
  );

  const departureAt = timestampFromInput(
    clean(payload.departureDate, 20),
    clean(payload.departureTime, 20),
    true
  );

  if (
    millis(arrivalAt) !== null &&
    millis(departureAt) !== null &&
    millis(departureAt) < millis(arrivalAt)
  ) {
    throw new Error(
      "Departure cannot be earlier than arrival."
    );
  }

  const accommodation =
    clean(payload.accommodation, 100) || "TBD";

  const pickupAt = payload.pickupRequired
    ? timestampFromInput(
        clean(payload.pickupDate, 20),
        clean(payload.pickupTime, 20),
        false
      )
    : null;

  const dropoffAt = payload.dropoffRequired
    ? timestampFromInput(
        clean(payload.dropoffDate, 20),
        clean(payload.dropoffTime, 20),
        false
      )
    : null;

  if (
    payload.pickupRequired &&
    cabScheduleInvalid("pickup", pickupAt, arrivalAt)
  ) {
    throw new Error("Pickup cannot be later than arrival.");
  }

  if (
    payload.dropoffRequired &&
    cabScheduleInvalid("dropoff", dropoffAt, departureAt)
  ) {
    throw new Error(
      "Drop-off cannot be earlier than departure."
    );
  }

  if (
    guest.personType === "Visitor" &&
    (
      payload.pickupRequired ||
      payload.dropoffRequired ||
      (payload.travelLegs || []).length
    )
  ) {
    throw new Error(
      "Visitors do not use personal cab or travel planning. Add them to a shared Trip instead."
    );
  }

  const requestedRoomList = (
    Array.isArray(payload.rooms)
      ? payload.rooms
      : []
  )
    .map(item => clean(item?.room || item, 300))
    .filter(Boolean);

  if (new Set(requestedRoomList).size !== requestedRoomList.length) {
    throw new Error("The same room cannot be assigned twice within one visit.");
  }

  const requestedRooms = [...new Set(requestedRoomList)];

  if (
    accommodation !== "Ashram" &&
    requestedRooms.length
  ) {
    throw new Error(
      "Rooms can only be assigned to an Ashram stay."
    );
  }

  const inventory = roomInventory(canonical);

  const inventoryByLabel = Object.fromEntries(
    inventory.map(item => [item.value, item])
  );

  requestedRooms.forEach(label => {
    if (!inventoryByLabel[label]) {
      throw new Error(`Unknown room: ${label}`);
    }
  });

  const existingRoomRows = canonical.visitRooms.filter(
    item => item.visitId === visitId
  );

  const acknowledgedSharedLabels = new Set(
    existingRoomRows
      .filter(item => item.sharedOk)
      .map(item => item.roomLabelSnapshot)
  );

  const shareAcks = new Set(
    Array.isArray(payload.sharedRoomAcks)
      ? payload.sharedRoomAcks
      : []
  );

  // Someone lives in this room. It is not shareable and not overridable —
  // it frees up when they move out of it or stop being a resident, and not
  // before. Checked regardless of dates, because a residency has none and
  // occupies the room for as long as it exists.
  requestedRooms.forEach(label => {
    const residentHolder = canonical.visitRooms
      .filter(item => item.visitId !== visitId && item.roomLabelSnapshot === label)
      .map(item => canonical.visits.find(visit => visit.id === item.visitId && !visit.isCancelled))
      .filter(Boolean)
      .find(visit => isResidencyStay(visit,
        (canonical.guests.find(guest => guest.id === visit.guestId) || {}).personType));
    if (residentHolder) {
      const holder = canonical.guests.find(guest => guest.id === residentHolder.guestId) || {};
      throw new Error(`${label} is occupied by ${holder.name || "a permanent resident"}.`);
    }
  });

  requestedRooms.forEach(label => {
    if (millis(arrivalAt) === null) return;

    const allocationRows = canonical.visitRooms.filter(
      item =>
        item.visitId !== visitId &&
        item.roomLabelSnapshot === label
    );

    const occupants = allocationRows.filter(allocation => {
      const other = canonical.visits.find(
        item =>
          item.id === allocation.visitId &&
          !item.isCancelled
      );

      return (
        other &&
        overlap(
          millis(arrivalAt),
          millis(departureAt),
          millis(other.arrivalAt),
          millis(other.departureAt)
        )
      );
    });

    // Room sleeping capacity is intentionally not a fixed database limit.
    // Any number of overlapping allocations may be made when the operator
    // explicitly acknowledges that this is a shared-room assignment.
    if (
      occupants.length &&
      !acknowledgedSharedLabels.has(label) &&
      !shareAcks.has(label)
    ) {
      throw new Error(
        `Confirm sharing ${label} before saving.`
      );
    }
  });

  const pickupConfirm = confirmationData(
    "pickup",
    payload,
    existing,
    arrivalAt,
    pickupAt
  );

  const dropoffConfirm = confirmationData(
    "dropoff",
    payload,
    existing,
    departureAt,
    dropoffAt
  );

  const visitData = {
    guestId,

    arrivalAt,
    arrivalDateKey: clean(payload.arrivalDate, 20),
    arrivalTimeConfirmed: Boolean(payload.arrivalTime),

    departureAt,
    departureDateKey: clean(payload.departureDate, 20),
    departureTimeConfirmed: Boolean(
      payload.departureTime
    ),

    accommodation,

    outsideAccommodationDetails: clean(
      payload.outsideAccommodationDetails
    ),

    outsideAccommodationConfirmed: Boolean(
      payload.outsideAccommodationConfirmed
    ),

    stayingAt: clean(payload.selfArrangedStayingAt),

    // Optional. "" means no preference was recorded, which is a different
    // thing from a deliberate Floor, so it is not defaulted here. Anything
    // outside the known seating values is dropped rather than stored.
    diningSeating: MEAL_SEATING.has(clean(payload.diningSeating, 40))
      ? clean(payload.diningSeating, 40)
      : "",

    // Where a resident lives, in plain words. Deliberately free text and not
    // a room id: their quarters are not guest inventory, which is the whole
    // reason they cannot be picked from the room list. Note that writing it
    // describes where they are — it reserves nothing. Holding a room out of
    // circulation is still done by marking that room permanent.
    residencyQuarters: clean(payload.residencyQuarters, 200),

    // Owned by the Meals workspace and carried straight through. This write is
    // a whole-document set, so anything not restated here would be erased by a
    // save from the visit editor — a workspace silently deleting another's
    // data, which is the one thing this architecture exists to prevent.
    residencyMeals: Array.isArray(existing?.residencyMeals)
      ? existing.residencyMeals.filter(meal => MEALS.includes(meal))
      : [],
    residencyMealNote: clean(existing?.residencyMealNote, 500),

    cFormComplete: Boolean(payload.isCformComplete),

    pickupRequired: Boolean(payload.pickupRequired),
    pickupAt,

    pickupDateKey: payload.pickupRequired
      ? clean(payload.pickupDate, 20)
      : "",

    pickupTimeConfirmed: Boolean(
      payload.pickupRequired && payload.pickupTime
    ),

    pickupFrom: payload.pickupRequired
      ? clean(payload.pickupFrom)
      : "",

    pickupDetails: payload.pickupRequired
      ? clean(payload.pickupDetails)
      : "",

    ...pickupConfirm,

    dropoffRequired: Boolean(payload.dropoffRequired),
    dropoffAt,

    dropoffDateKey: payload.dropoffRequired
      ? clean(payload.dropoffDate, 20)
      : "",

    dropoffTimeConfirmed: Boolean(
      payload.dropoffRequired && payload.dropoffTime
    ),

    dropoffTo: payload.dropoffRequired
      ? clean(payload.dropoffTo)
      : "",

    dropoffDetails: payload.dropoffRequired
      ? clean(payload.dropoffDetails)
      : "",

    ...dropoffConfirm,

    isCancelled: Boolean(existing?.isCancelled),
    cancelledAt: existing?.cancelledAt || null,

    hasArrivalDate: Boolean(arrivalAt),
    calendarStartAt: arrivalAt,

    calendarEndAt: arrivalAt
      ? (
          departureAt ||
          Timestamp.fromDate(
            new Date("2099-12-31T18:29:59.999Z")
          )
        )
      : null,

    schemaVersion: 1,
    updatedAt: serverTimestamp(),
    updatedBy: actor,

    createdAt:
      existing?.createdAt || serverTimestamp(),

    createdBy:
      existing?.createdBy || actor
  };

  const travelPayloads = Array.isArray(
    payload.travelLegs
  )
    ? payload.travelLegs
    : [];

  let previousTravelMs = null;

  travelPayloads.forEach((leg, index) => {
    const at = timestampFromInput(
      clean(leg.travelDate, 20),
      clean(leg.travelTime, 20),
      false
    );

    if (
      at &&
      previousTravelMs !== null &&
      millis(at) <= previousTravelMs
    ) {
      throw new Error(
        `Travel leg ${index + 1} must be later than the preceding dated leg.`
      );
    }

    if (at) {
      previousTravelMs = millis(at);
    }
  });

  const guestRef = doc(db, "guests", guestId);
  const visitRef = doc(db, "visits", visitId);

  const oldLegs = canonical.visitTravelLegs.filter(
    item => item.visitId === visitId
  );

  await runTransaction(db, async transaction => {
    /*
     * Firestore requires all transaction reads to occur
     * before the first write.
     *
     * Reading both parent records here also guarantees that
     * the new guest and first visit are committed together.
     */

    const currentGuest =
      await transaction.get(guestRef);

    const current =
      await transaction.get(visitRef);

    if (newGuestData) {
      if (currentGuest.exists()) {
        throw new Error(
          "This guest was added by someone else. Choose the existing guest instead."
        );
      }
    } else if (
      !currentGuest.exists() ||
      currentGuest.data().archived
    ) {
      throw new Error("This guest no longer exists.");
    }

    if (current.exists()) {
      assertVersion(current.data(), payload.version);
    } else if (existing) {
      throw new Error("This visit no longer exists.");
    }

    if (newGuestData) {
      transaction.set(guestRef, {
        ...newGuestData,
        createdAt: serverTimestamp(),
        createdBy: actor
      });

      transaction.set(
        doc(collection(db, "auditLogs")),
        auditEntry(
          actor,
          "guest",
          guestId,
          "create",
          ["name", "personType"]
        )
      );
    }

    transaction.set(visitRef, visitData);

    const newRoomIds = new Set();

    requestedRooms.forEach((label, index) => {
      const inventoryItem =
        inventoryByLabel[label];

      const prior = existingRoomRows.find(
        item => item.roomLabelSnapshot === label
      );

      const allocationId =
        prior?.id ||
        `${visitId}--${inventoryItem.roomId}`;

      newRoomIds.add(allocationId);

      transaction.set(
        doc(db, "visitRooms", allocationId),
        {
          visitId,
          roomId: inventoryItem.roomId,
          roomLabelSnapshot: label,
          order: index + 1,

          sharedOk: Boolean(prior?.sharedOk) || shareAcks.has(label),

          createdAt:
            prior?.createdAt || serverTimestamp(),

          createdBy:
            prior?.createdBy || actor,

          updatedAt: serverTimestamp(),
          updatedBy: actor,
          schemaVersion: 1
        }
      );
    });

    existingRoomRows
      .filter(item => !newRoomIds.has(item.id))
      .forEach(item =>
        transaction.delete(
          doc(db, "visitRooms", item.id)
        )
      );

    const newLegIds = new Set();

    travelPayloads.forEach((leg, index) => {
      const legId =
        clean(leg.travelId, 100) || uuid();

      newLegIds.add(legId);

      const old = oldLegs.find(
        item => item.id === legId
      );

      transaction.set(
        doc(db, "visitTravelLegs", legId),
        {
          visitId,

          direction:
            clean(leg.direction, 100) || "Inbound",

          transportType:
            clean(leg.transportType, 100) || "Other",

          from: clean(leg.from),
          to: clean(leg.to),

          travelAt: timestampFromInput(
            clean(leg.travelDate, 20),
            clean(leg.travelTime, 20),
            false
          ),

          travelDateKey: clean(
            leg.travelDate,
            20
          ),

          timeConfirmed: Boolean(
            leg.travelTime
          ),

          status:
            clean(leg.status, 100) || "Required",

          serviceNumber: clean(
            leg.serviceNumber
          ),

          bookingReference: clean(
            leg.bookingReference
          ),

          notes: clean(leg.notes),
          order: index + 1,

          createdAt:
            old?.createdAt || serverTimestamp(),

          createdBy:
            old?.createdBy || actor,

          updatedAt: serverTimestamp(),
          updatedBy: actor,
          schemaVersion: 1
        }
      );
    });

    oldLegs
      .filter(item => !newLegIds.has(item.id))
      .forEach(item =>
        transaction.delete(
          doc(db, "visitTravelLegs", item.id)
        )
      );

    transaction.set(
      doc(collection(db, "auditLogs")),
      auditEntry(
        actor,
        "visit",
        visitId,
        existing ? "update" : "create",
        [
          "stay",
          "accommodation",
          "rooms",
          "cabs",
          "travelLegs"
        ]
      )
    );
  });

  invalidate();

  return {
    visitId,
    guestId,
    guestCreated: Boolean(newGuestData),
    version: await committedVersion(
      "visits",
      visitId
    )
  };
}

  function validateMealSource_(canonical, sourceType, sourceId, dateKey, startDateKey, endDateKey) {
    if (sourceType === "individualGuest") {
      const guest = canonical.guests.find(item => item.id === sourceId && !item.archived);
      if (!guest) throw new Error("This guest no longer exists.");
      return;
    }
    if (sourceType === "sevaTeam") {
      const team = canonical.sevaTeams.find(item => item.id === sourceId);
      if (!team) throw new Error("This Seva Team no longer exists.");
      const from = dateKey || startDateKey;
      const to = dateKey || endDateKey || from;
      if (team.startDateKey && from && from < team.startDateKey) throw new Error("The meal schedule cannot start before the Seva Team starts.");
      if (team.endDateKey && to && to > team.endDateKey) throw new Error("The meal schedule cannot continue after the Seva Team ends.");
      return;
    }
    const task = canonical.specificSeva.find(item => item.id === sourceId);
    if (!task) throw new Error("This individual seva assignment no longer exists.");
    const from = dateKey || startDateKey;
    const to = dateKey || endDateKey || from;
    if (task.startDateKey && from && from < task.startDateKey) throw new Error("The meal arrangement cannot start before this seva starts.");
    if (task.endDateKey && to && to > task.endDateKey) throw new Error("The meal arrangement cannot continue after this seva ends.");
  }

  async function saveMealSchedule(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const sourceType = clean(payload?.sourceType, 40) || "individualGuest";
    if (!MEAL_SOURCE_TYPES.has(sourceType)) throw new Error("Choose a valid meal arrangement type.");

    let sourceId = clean(payload?.sourceId || payload?.guestId, 100);
    let newGuestData = null;
    if (sourceType === "individualGuest" && payload?.newGuest && typeof payload.newGuest === "object") {
      sourceId = sourceId || uuid();
      newGuestData = guestWriteData(payload.newGuest, actor);
      if (canonical.guests.some(item => item.id === sourceId)) throw new Error("A guest with this ID already exists.");
      if (canonical.guests.some(item => (item.nameNormalized || clean(item.name).toLowerCase()) === newGuestData.nameNormalized)) {
        throw new Error("A guest with this name already exists. Choose the existing guest instead.");
      }
    }
    if (!sourceId) throw new Error("Choose who this meal arrangement belongs to.");

    const recurrence = clean(payload?.recurrence, 40) || "oneTime";
    if (!MEAL_RECURRENCES.has(recurrence)) throw new Error("Choose a valid schedule pattern.");
    const dateKey = recurrence === "oneTime" ? clean(payload?.date, 20) : "";
    const startDateKey = recurrence === "oneTime" ? "" : clean(payload?.startDate, 20);
    const endDateKey = recurrence === "oneTime" ? "" : clean(payload?.endDate, 20);
    if (recurrence === "oneTime" && !dateKey) throw new Error("Choose the meal date.");
    if (recurrence !== "oneTime" && !startDateKey) throw new Error("Choose when the recurring arrangement starts.");
    if (endDateKey && endDateKey < startDateKey) throw new Error("The end date cannot be before the start date.");
    const weekdays = recurrence === "weekly"
      ? [...new Set((Array.isArray(payload?.weekdays) ? payload.weekdays : []).map(Number).filter(day => day >= 0 && day <= 6))]
      : [];
    if (recurrence === "weekly" && !weekdays.length) throw new Error("Choose at least one weekday.");
    const meals = [...new Set((Array.isArray(payload?.meals) ? payload.meals : []).map(item => clean(item, 30)).filter(item => MEALS.includes(item)))];
    if (!meals.length) throw new Error("Choose at least one meal.");
    const defaultSeating = mealSeating(payload?.defaultSeating);

    if (!newGuestData) validateMealSource_(canonical, sourceType, sourceId, dateKey, startDateKey, endDateKey);
    const scheduleId = clean(payload?.scheduleId, 100) || uuid();
    const scheduleRef = doc(db, "mealSchedules", scheduleId);
    const guestRef = newGuestData ? doc(db, "guests", sourceId) : null;
    await runTransaction(db, async transaction => {
      const scheduleSnapshot = await transaction.get(scheduleRef);
      if (scheduleSnapshot.exists()) assertVersion(scheduleSnapshot.data(), payload?.version);
      if (newGuestData) {
        if ((await transaction.get(guestRef)).exists()) throw new Error("A guest with this ID already exists.");
        transaction.set(guestRef, { ...newGuestData, createdAt: serverTimestamp(), createdBy: actor });
        transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "guest", sourceId, "create", ["name", "personType"]));
      }
      const existing = scheduleSnapshot.exists() ? scheduleSnapshot.data() : null;
      transaction.set(scheduleRef, {
        sourceType,
        sourceId,
        recurrence,
        dateKey,
        weekdays,
        startDateKey,
        endDateKey,
        meals,
        defaultSeating,
        note: clean(payload?.note),
        active: payload?.active !== false,
        createdAt: existing?.createdAt || serverTimestamp(),
        createdBy: existing?.createdBy || actor,
        updatedAt: serverTimestamp(),
        updatedBy: actor,
        schemaVersion: 1
      });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(
        actor, "mealSchedule", scheduleId, existing ? "update" : "create",
        ["sourceType", "sourceId", "recurrence", "dateKey", "weekdays", "startDateKey", "endDateKey", "meals", "defaultSeating", "note", "active"]
      ));
    });
    invalidate();
    return { scheduleId, guestId: sourceType === "individualGuest" ? sourceId : "", guestCreated: Boolean(newGuestData), version: await committedVersion("mealSchedules", scheduleId) };
  }

  async function deleteMealSchedule(scheduleId) {
    const actor = ensureApproved();
    const id = clean(scheduleId, 100);
    const reference = doc(db, "mealSchedules", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This meal arrangement no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "mealSchedule", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { scheduleId: id, deleted: true };
  }

  async function savePermanentResident(payload) {
    const actor = ensureApproved();
    const name = clean(payload?.name);
    if (!name) throw new Error("Resident name is required.");
    const activeFromKey = clean(payload?.activeFrom, 20);
    const activeUntilKey = clean(payload?.activeUntil, 20);
    if (activeFromKey && activeUntilKey && activeUntilKey < activeFromKey) throw new Error("The end date cannot be before the start date.");
    const id = clean(payload?.residentId, 100) || uuid();
    const reference = doc(db, "permanentResidents", id);
    await runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (snapshot.exists()) assertVersion(snapshot.data(), payload?.version);
      const existing = snapshot.exists() ? snapshot.data() : null;
      transaction.set(reference, {
        name,
        nameNormalized: name.toLowerCase(),
        defaultSeating: mealSeating(payload?.defaultSeating),
        activeFromKey,
        activeUntilKey,
        active: payload?.active !== false,
        note: clean(payload?.note),
        // Owned by the Meals workspace, restated because this is a whole
        // document set — the same way the residency plan is preserved on
        // visits. Without these two lines, editing a resident's name would
        // silently reset which meals they take.
        meals: Array.isArray(existing?.meals) ? existing.meals.filter(meal => MEALS.includes(meal)) : [],
        mealNote: clean(existing?.mealNote, 500),
        createdAt: existing?.createdAt || serverTimestamp(),
        createdBy: existing?.createdBy || actor,
        updatedAt: serverTimestamp(),
        updatedBy: actor,
        schemaVersion: 1
      });
      transaction.set(doc(collection(db, "auditLogs")), auditEntry(actor, "permanentResident", id, existing ? "update" : "create", ["name", "defaultSeating", "activeFromKey", "activeUntilKey", "active", "note"]));
    });
    invalidate();
    return { residentId: id, version: await committedVersion("permanentResidents", id) };
  }

  async function deletePermanentResident(residentId) {
    const actor = ensureApproved();
    const id = clean(residentId, 100);
    const reference = doc(db, "permanentResidents", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This resident no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "permanentResident", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { residentId: id, deleted: true };
  }

  async function upsertMealOverride(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const subjectType = payload?.subjectType === "permanentResident" ? "permanentResident" : "guest";
    const subjectId = clean(payload?.subjectId || payload?.guestId, 100);
    const dateKey = clean(payload?.date, 20);
    const meal = clean(payload?.meal, 30);
    const subjectExists = subjectType === "permanentResident"
      ? canonical.permanentResidents.some(item => item.id === subjectId)
      : canonical.guests.some(item => item.id === subjectId && !item.archived);
    if (!subjectExists) throw new Error(subjectType === "permanentResident" ? "This resident no longer exists." : "This guest no longer exists.");
    if (!dateKey || !MEALS.includes(meal)) throw new Error("A valid date and meal are required.");
    const requestedId = clean(payload.overrideId, 100);
    const naturalKeyMatch = canonical.mealOverrides.find(item => {
      const existingType = item.subjectType === "permanentResident" ? "permanentResident" : "guest";
      const existingId = item.subjectId || item.guestId;
      return existingType === subjectType && existingId === subjectId && item.dateKey === dateKey && item.meal === meal;
    });
    const id = requestedId || naturalKeyMatch?.id || `${subjectType}--${subjectId}--${dateKey}--${meal.toLowerCase().replace(/\s+/g, "-")}`;
    const existing = canonical.mealOverrides.find(item => item.id === id);
    await setDoc(doc(db, "mealOverrides", id), {
      subjectType,
      subjectId,
      guestId: subjectType === "guest" ? subjectId : "",
      dateKey,
      meal,
      included: Boolean(payload.included),
      seatingOverride: payload.seatingOverride ? mealSeating(payload.seatingOverride) : "",
      note: clean(payload.note),
      createdAt: existing?.createdAt || serverTimestamp(), createdBy: existing?.createdBy || actor,
      updatedAt: serverTimestamp(), updatedBy: actor, schemaVersion: 1
    });
    await setDoc(doc(collection(db, "auditLogs")), auditEntry(actor, "mealOverride", id, existing ? "update" : "create", ["included", "seatingOverride", "note"]));
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

  // Cancelled is gone: a meeting that was called off is deleted, not parked in
  // a status nobody revisits. Scheduled and Completed are the only outcomes.
  async function setMeetingStatus(meetingId, status, suppliedVersion) {
    if (!["Scheduled", "Completed"].includes(status)) throw new Error("Invalid meeting status.");
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
      const startAt = timestampFromInput(startDateKey, "", false), endAt = timestampFromInput(endDateKey, "", true);
      transaction.set(reference, {
        name, purpose: clean(payload.purpose), startAt, startDateKey, endAt, endDateKey,
        calendarStartAt: startAt, calendarEndAt: endAt,
        // Carried forward untouched rather than written: a trip is deleted when
        // it's called off, so nothing sets this any more, but an existing
        // cancelled row keeps its flag and stays out of the live lists.
        isCancelled: Boolean(existing?.isCancelled),
        cancelledAt: existing?.cancelledAt || null,
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

  // ---- Permanent deletes -------------------------------------------------
  // Deleting is now the only way to remove any of these. The soft-delete that
  // sat alongside it — cancelVisit, a Cancelled meeting status, a trip
  // cancelled flag — went unused in practice while costing a filter in every
  // read path, so it was taken out.
  //
  // A visit and a trip each own child collections. Firestore has no cascade
  // delete, so removing the parent alone would leave rooms and travel legs
  // holding a visitId that no longer resolves. Children go in the same batch:
  // one atomic commit or nothing.

  async function deleteChildDocs_(batch, collectionName, field, parentId) {
    const snapshot = await getDocs(query(collection(db, collectionName), where(field, "==", parentId)));
    snapshot.docs.forEach(item => batch.delete(item.ref));
    return snapshot.size;
  }

  async function deleteVisit(visitId) {
    const actor = ensureApproved();
    const id = clean(visitId, 100);
    const reference = doc(db, "visits", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This visit no longer exists.");
    const batch = writeBatch(db);
    const rooms = await deleteChildDocs_(batch, "visitRooms", "visitId", id);
    const legs = await deleteChildDocs_(batch, "visitTravelLegs", "visitId", id);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "visit", id, "delete", ["document", `rooms:${rooms}`, `travelLegs:${legs}`]);
    await batch.commit();
    invalidate();
    return { visitId: id, deleted: true, roomsDeleted: rooms, travelLegsDeleted: legs };
  }

  async function deleteTrip(tripId) {
    const actor = ensureApproved();
    const id = clean(tripId, 100);
    const reference = doc(db, "trips", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This trip no longer exists.");
    const batch = writeBatch(db);
    const participants = await deleteChildDocs_(batch, "tripParticipants", "tripId", id);
    const legs = await deleteChildDocs_(batch, "tripTravelLegs", "tripId", id);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "trip", id, "delete", ["document", `participants:${participants}`, `travelLegs:${legs}`]);
    await batch.commit();
    invalidate();
    return { tripId: id, deleted: true, participantsDeleted: participants, travelLegsDeleted: legs };
  }

  async function deleteMeeting(meetingId) {
    const actor = ensureApproved();
    const id = clean(meetingId, 100);
    const reference = doc(db, "meetings", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This meeting no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "meeting", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { meetingId: id, deleted: true };
  }

  // Deleting a meal override doesn't remove a meal — it drops the exception,
  // so the guest reverts to whatever their residency implies for that day.
  async function deleteMealOverride(overrideId) {
    const actor = ensureApproved();
    const id = clean(overrideId, 100);
    const reference = doc(db, "mealOverrides", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This meal record no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "mealOverride", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { overrideId: id, deleted: true };
  }

  // Seating chosen in the Meals workspace applies from that date onward. Any
  // change already recorded on or after the same date is removed first, so the
  // newest instruction always owns the future and no stale later entry can
  // quietly take over a few days on. Earlier changes stay untouched — that is
  // what keeps past days reading as they did.
  async function setMealSeatingFrom(payload) {
    const actor = ensureApproved();
    const canonical = await loadCanonical();
    const subjectType = payload?.subjectType === "permanentResident" ? "permanentResident" : "guest";
    const subjectId = clean(payload?.subjectId, 100);
    const fromKey = clean(payload?.fromKey, 20);
    const seating = mealSeating(payload?.seating, "");
    if (!subjectId) throw new Error("This person no longer exists.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromKey)) throw new Error("A date is needed to set seating from.");
    if (!seating) throw new Error("Choose Floor or Table.");

    const superseded = canonical.mealSeatingChanges.filter(item =>
      item.subjectType === subjectType && item.subjectId === subjectId
      && clean(item.fromKey, 20) >= fromKey);

    const id = `${subjectType}--${subjectId}--${fromKey}`;
    const batch = writeBatch(db);
    superseded.forEach(item => { if (item.id !== id) batch.delete(doc(db, "mealSeatingChanges", item.id)); });
    batch.set(doc(db, "mealSeatingChanges", id), {
      subjectType, subjectId, fromKey, seating,
      updatedAt: Timestamp.now(), updatedBy: actor
    });
    await writeAuditBatch(batch, actor, "mealSeatingChange", id, "set", ["seating", "fromKey"]);
    await batch.commit();
    invalidate();
    return { seatingChangeId: id, fromKey, seating, supersededCount: superseded.length };
  }

  // ---- Resident/guest merge: audit -------------------------------------
  // Step one of turning permanent residents into ordinary guests. This reads
  // and reports; it writes nothing, invalidates nothing, and is safe to run as
  // often as you like. Its job is to answer, before anything is decided:
  // whether the 8 residents are who we think they are, whether any of them
  // already exists as a guest under another spelling, and exactly how many
  // meal records would have to be re-keyed from a resident id to a guest id.
  //
  // Everything reported here is deliberately raw. It draws no conclusions and
  // performs no matching beyond a normalised name comparison, because the one
  // thing that would make the migration dangerous — the same human existing
  // twice — is precisely the thing a machine should flag rather than resolve.
  async function auditResidentMerge() {
    ensureApproved();
    const canonical = await loadCanonical();
    const normalise = value => clean(value, 200).toLowerCase().replace(/[^a-z0-9]/g, "");

    const guestsByName = new Map();
    canonical.guests.filter(item => !item.archived).forEach(item => {
      const key = normalise(item.nameNormalized || item.name);
      if (!key) return;
      if (!guestsByName.has(key)) guestsByName.set(key, []);
      guestsByName.get(key).push({ guestId: item.id, name: item.name || "", personType: item.personType || "" });
    });

    // A permanent room is inventory that has been taken out of circulation.
    // Matching is by occupant name, which is the only link the data has.
    const permanentRooms = canonical.rooms.filter(room =>
      room.permanent || clean(room.category, 100).toLowerCase() === "permanent");
    const claimedRoomIds = new Set();

    const countFor = (list, id) => list.filter(item =>
      item.subjectType === "permanentResident" && item.subjectId === id).length;

    const residents = canonical.permanentResidents.map(item => {
      const key = normalise(item.name);
      const rooms = permanentRooms.filter(room => normalise(room.occupant) === key && key);
      rooms.forEach(room => claimedRoomIds.add(room.id));
      const collisions = guestsByName.get(key) || [];
      return {
        residentId: item.id,
        name: item.name || "",
        active: item.active !== false,
        activeFrom: item.activeFromKey || "",
        activeUntil: item.activeUntilKey || "",
        meals: residentMeals(item),
        mealsNarrowed: residentMeals(item).length !== MEALS.length,
        defaultSeating: mealSeating(item.defaultSeating),
        mealNote: item.mealNote || "",
        note: item.note || "",
        permanentRooms: rooms.map(room => room.displayName || `${room.building} - ${room.room}`),
        existingGuestMatches: collisions,
        recordsToRekey: {
          mealAbsences: countFor(canonical.mealAbsences, item.id),
          mealSeatingChanges: countFor(canonical.mealSeatingChanges, item.id),
          mealOverrides: countFor(canonical.mealOverrides, item.id)
        }
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const warnings = [];
    residents.forEach(entry => {
      if (!entry.name) warnings.push(`Resident ${entry.residentId} has no name — it cannot be matched or migrated as is.`);
      if (entry.existingGuestMatches.length) {
        warnings.push(`"${entry.name}" already matches ${entry.existingGuestMatches.length} guest record(s). Migrating would create the same person twice unless these are linked instead.`);
      }
      if (!entry.permanentRooms.length) warnings.push(`No permanent room is recorded against "${entry.name}".`);
      if (entry.permanentRooms.length > 1) warnings.push(`"${entry.name}" is the occupant of ${entry.permanentRooms.length} permanent rooms.`);
      if (!entry.active) warnings.push(`"${entry.name}" is marked inactive — decide whether they should be migrated at all.`);
      if (entry.activeUntil && entry.activeUntil < dateKeyOf(Date.now())) {
        warnings.push(`"${entry.name}" has an active-until date in the past (${entry.activeUntil}).`);
      }
    });
    permanentRooms.filter(room => !claimedRoomIds.has(room.id)).forEach(room => {
      warnings.push(`Permanent room "${room.displayName || `${room.building} - ${room.room}`}" has occupant "${room.occupant || ""}" which matches no resident.`);
    });

    const totals = residents.reduce((acc, entry) => ({
      mealAbsences: acc.mealAbsences + entry.recordsToRekey.mealAbsences,
      mealSeatingChanges: acc.mealSeatingChanges + entry.recordsToRekey.mealSeatingChanges,
      mealOverrides: acc.mealOverrides + entry.recordsToRekey.mealOverrides
    }), { mealAbsences: 0, mealSeatingChanges: 0, mealOverrides: 0 });

    return {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      residentCount: residents.length,
      guestCount: canonical.guests.filter(item => !item.archived).length,
      permanentRoomCount: permanentRooms.length,
      totalsToRekey: totals,
      residents,
      warnings,
      summary: [
        `${residents.length} permanent residents, ${canonical.guests.filter(item => !item.archived).length} active guests.`,
        `${permanentRooms.length} rooms are held out of guest inventory as permanent.`,
        `${totals.mealAbsences + totals.mealSeatingChanges + totals.mealOverrides} meal records would need re-keying (${totals.mealAbsences} away, ${totals.mealSeatingChanges} seating, ${totals.mealOverrides} daily).`,
        warnings.length ? `${warnings.length} thing(s) to look at before migrating.` : "Nothing flagged."
      ]
    };
  }

  // ---- Resident/guest merge: migration ---------------------------------
  // Turns each permanent resident into an ordinary guest plus one open-ended
  // ashram stay carrying their meals, seating and note. Nothing is deleted:
  // the permanentResidents records are left exactly as they are, so the app
  // keeps reading them until the reads are switched over separately, and so
  // this can be undone by removing what it wrote.
  //
  // A dry run unless { commit: true } is passed. The dry run does the identical
  // work and returns the identical plan — it simply never hands the batch to
  // Firestore — so what you review is what would happen.
  //
  // Safe to run more than once: ids are derived from the resident id, and a
  // resident whose guest record already exists is skipped rather than
  // rewritten, so a re-run finishes a partial job instead of duplicating it.
  async function migrateResidentsToGuests(options) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const commit = options?.commit === true;
    const normalise = value => clean(value, 200).toLowerCase().replace(/[^a-z0-9]/g, "");

    const guestsById = Object.fromEntries(canonical.guests.map(item => [item.id, item]));
    const guestsByName = new Map();
    canonical.guests.filter(item => !item.archived).forEach(item => {
      const key = normalise(item.nameNormalized || item.name);
      if (key) guestsByName.set(key, item.id);
    });

    const plan = [];
    const blocked = [];
    const writes = [];

    canonical.permanentResidents.forEach(resident => {
      const residentId = resident.id;
      const name = clean(resident.name);
      const guestId = `MIG-RES-${residentId}`;
      const visitId = `MIG-RESV-${residentId}`;

      if (!name) {
        blocked.push({ residentId, reason: "This resident has no name, so no guest record can be made from it." });
        return;
      }
      // Re-checked here rather than trusted from the audit: a matching guest
      // may have been added in between.
      const collision = guestsByName.get(normalise(name));
      if (collision && collision !== guestId) {
        blocked.push({ residentId, name, reason: `A guest named "${name}" already exists (${collision}). Link or rename before migrating this one.` });
        return;
      }
      if (guestsById[guestId]) {
        plan.push({ residentId, name, guestId, visitId, action: "already-migrated", records: 0 });
        return;
      }

      const rekey = [];
      const move = (collectionName, rows, idFor) => rows.forEach(row => {
        const nextId = idFor(row);
        rekey.push({ collection: collectionName, from: row.id, to: nextId });
        writes.push({ type: "delete", collection: collectionName, id: row.id });
        const data = { ...row, subjectType: "guest", subjectId: guestId, updatedAt: Timestamp.now(), updatedBy: actor };
        if (collectionName === "mealOverrides") data.guestId = guestId;
        delete data.id;
        writes.push({ type: "set", collection: collectionName, id: nextId, data });
      });

      const mine = list => list.filter(item => item.subjectType === "permanentResident" && item.subjectId === residentId);
      move("mealAbsences", mine(canonical.mealAbsences), row => `guest--${guestId}--${clean(row.fromKey, 20)}`);
      move("mealSeatingChanges", mine(canonical.mealSeatingChanges), row => `guest--${guestId}--${clean(row.fromKey, 20)}`);
      move("mealOverrides", mine(canonical.mealOverrides), row =>
        `guest--${guestId}--${clean(row.dateKey, 20)}--${clean(row.meal, 40).toLowerCase().replace(/\s+/g, "-")}`);

      writes.push({
        type: "set", collection: "guests", id: guestId,
        data: {
          name,
          nameNormalized: name.toLowerCase(),
          foreignNational: false,
          personType: "Permanent Resident",
          invitedPurposes: [],
          invitedPurposeOther: "",
          staffAssignment: "",
          archived: false,
          archivedAt: null,
          migratedFromResidentId: residentId,
          schemaVersion: 1,
          createdAt: Timestamp.now(), createdBy: actor,
          updatedAt: Timestamp.now(), updatedBy: actor
        }
      });

      // No arrival or departure: living here has no beginning to record, which
      // is the shape chosen over inventing a date. hasArrivalDate stays false
      // and the calendar fields stay null, exactly as for any dateless stay,
      // so nothing downstream has to special-case the document itself.
      writes.push({
        type: "set", collection: "visits", id: visitId,
        data: {
          guestId,
          arrivalAt: null, arrivalDateKey: "", arrivalTimeConfirmed: false,
          departureAt: null, departureDateKey: "", departureTimeConfirmed: false,
          accommodation: "Ashram",
          outsideAccommodationDetails: "", outsideAccommodationConfirmed: false,
          stayingAt: "",
          diningSeating: mealSeating(resident.defaultSeating),
          residencyMeals: residentMeals(resident),
          residencyMealNote: clean(resident.mealNote, 500),
          cFormComplete: false,
          pickupRequired: false, pickupAt: null, pickupDateKey: "", pickupTimeConfirmed: false,
          pickupFrom: "", pickupDetails: "",
          dropoffRequired: false, dropoffAt: null, dropoffDateKey: "", dropoffTimeConfirmed: false,
          dropoffTo: "", dropoffDetails: "",
          isCancelled: false, cancelledAt: null,
          hasArrivalDate: false, calendarStartAt: null, calendarEndAt: null,
          migratedFromResidentId: residentId,
          schemaVersion: 1,
          createdAt: Timestamp.now(), createdBy: actor,
          updatedAt: Timestamp.now(), updatedBy: actor
        }
      });

      plan.push({
        residentId, name, guestId, visitId, action: "migrate",
        personType: "Permanent Resident",
        meals: residentMeals(resident),
        seating: mealSeating(resident.defaultSeating),
        mealNote: clean(resident.mealNote, 500),
        rekey,
        records: 2 + rekey.length
      });
    });

    const result = {
      generatedAt: new Date().toISOString(),
      committed: false,
      residentsSeen: canonical.permanentResidents.length,
      toMigrate: plan.filter(item => item.action === "migrate").length,
      alreadyMigrated: plan.filter(item => item.action === "already-migrated").length,
      blocked,
      documentsToWrite: writes.filter(item => item.type === "set").length,
      documentsToDelete: writes.filter(item => item.type === "delete").length,
      plan,
      note: "permanentResidents records are left untouched, and nothing reads the new records until the read switch ships."
    };

    if (!commit) {
      result.summary = [
        "DRY RUN — nothing was written.",
        `${result.toMigrate} resident(s) would become guests, ${result.alreadyMigrated} already done, ${blocked.length} blocked.`,
        `${result.documentsToWrite} document(s) created, ${result.documentsToDelete} re-keyed away.`,
        blocked.length ? "Resolve the blocked entries before committing." : "Nothing is blocking a commit."
      ];
      return result;
    }
    if (blocked.length) throw new Error(`${blocked.length} resident(s) are blocked. Resolve them before committing.`);

    // One batch: the whole migration lands or none of it does, so a failure
    // cannot leave a guest without their stay, or a half-re-keyed meal record.
    const batch = writeBatch(db);
    writes.forEach(item => {
      const reference = doc(db, item.collection, item.id);
      if (item.type === "delete") batch.delete(reference);
      else batch.set(reference, item.data);
    });
    await writeAuditBatch(batch, actor, "residentMerge", "all", "migrate", ["guests", "visits", "mealRecords"]);
    await batch.commit();
    invalidate();
    result.committed = true;
    result.summary = [`Committed. ${result.toMigrate} resident(s) migrated, ${result.documentsToWrite} document(s) written.`];
    return result;
  }

  // ---- Resident rooms: bring them back into inventory -------------------
  // Residents' rooms were held out of the guest room list by a "permanent"
  // flag, which made them invisible rather than occupied — nobody could pick
  // them, including the resident. They are ordinary ashram rooms, so this
  // puts each one back into inventory and assigns it to the resident's stay
  // instead. Occupancy then does the work the flag was doing: the stay never
  // ends, so the room stays locked, and moving the resident frees it.
  //
  // A dry run unless { commit: true } is passed, and safe to run again: a
  // room already assigned to its resident is skipped rather than rewritten.
  async function migrateResidentRooms(options) {
    const actor = ensureApproved();
    const canonical = await loadCanonical(true);
    const commit = options?.commit === true;

    const plan = [];
    const blocked = [];
    const writes = [];

    canonical.guests
      .filter(guest => !guest.archived && guest.personType === "Permanent Resident")
      .forEach(guest => {
        const stay = canonical.visits.find(visit => visit.guestId === guest.id
          && !visit.isCancelled && visit.accommodation === "Ashram");
        if (!stay) {
          blocked.push({ name: guest.name, reason: "No residency stay to attach a room to." });
          return;
        }
        const key = clean(guest.name, 200).toLowerCase().replace(/[^a-z0-9]/g, "");
        const rooms = canonical.rooms.filter(room =>
          (room.permanent || clean(room.category, 100).toLowerCase() === "permanent")
          && key && clean(room.occupant, 200).toLowerCase().replace(/[^a-z0-9]/g, "") === key);
        if (!rooms.length) {
          plan.push({ name: guest.name, visitId: stay.id, action: "no-room-on-record", rooms: [] });
          return;
        }

        const already = canonical.visitRooms.filter(item => item.visitId === stay.id);
        const moved = [];
        rooms.forEach((room, index) => {
          const label = room.displayName || (clean(room.building, 100) + " - " + clean(room.room, 100));
          // Someone else already holds it. Never silently double-assign.
          const heldByOther = canonical.visitRooms.find(item => item.roomLabelSnapshot === label
            && item.visitId !== stay.id
            && canonical.visits.some(visit => visit.id === item.visitId && !visit.isCancelled));
          if (heldByOther) {
            blocked.push({ name: guest.name, room: label,
              reason: "This room is already allocated to another stay." });
            return;
          }
          const allocationId = "RESROOM-" + stay.id + "-" + room.id;
          if (!already.some(item => item.roomLabelSnapshot === label)) {
            writes.push({ type: "set", collection: "visitRooms", id: allocationId, data: {
              visitId: stay.id,
              roomId: room.id,
              roomLabelSnapshot: label,
              order: index + 1,
              sharedOk: false,
              createdAt: Timestamp.now(), createdBy: actor,
              updatedAt: Timestamp.now(), updatedBy: actor,
              schemaVersion: 1
            } });
          }
          // Back into circulation as an ordinary room. It is not free — the
          // resident's stay holds it — but that is now a fact about who is in
          // it rather than a property of the room itself.
          writes.push({ type: "update", collection: "rooms", id: room.id, data: {
            permanent: false,
            category: clean(room.category, 100).toLowerCase() === "permanent" ? "Normal" : (room.category || "Normal"),
            updatedAt: Timestamp.now(), updatedBy: actor
          } });
          moved.push(label);
        });

        if (moved.length) plan.push({ name: guest.name, visitId: stay.id, action: "assign", rooms: moved });
      });

    const result = {
      generatedAt: new Date().toISOString(),
      committed: false,
      residentsSeen: canonical.guests.filter(guest => !guest.archived
        && guest.personType === "Permanent Resident").length,
      roomsToAssign: plan.filter(item => item.action === "assign").reduce((total, item) => total + item.rooms.length, 0),
      withoutRoomOnRecord: plan.filter(item => item.action === "no-room-on-record").map(item => item.name),
      blocked,
      documentsToWrite: writes.length,
      plan
    };

    if (!commit) {
      result.summary = [
        "DRY RUN — nothing was written.",
        result.roomsToAssign + " room(s) would be assigned to their resident and returned to inventory.",
        result.withoutRoomOnRecord.length
          ? "No room on record for: " + result.withoutRoomOnRecord.join(", ") + " (use the Quarters field for them)."
          : "Every resident has a room on record.",
        blocked.length ? blocked.length + " blocked — resolve before committing." : "Nothing is blocking a commit."
      ];
      return result;
    }
    if (blocked.length) throw new Error(blocked.length + " item(s) are blocked. Resolve them before committing.");

    const batch = writeBatch(db);
    writes.forEach(item => {
      const reference = doc(db, item.collection, item.id);
      if (item.type === "update") batch.update(reference, item.data);
      else batch.set(reference, item.data);
    });
    await writeAuditBatch(batch, actor, "residentRooms", "all", "migrate", ["visitRooms", "rooms"]);
    await batch.commit();
    invalidate();
    result.committed = true;
    result.summary = ["Committed. " + result.roomsToAssign + " room(s) assigned and returned to inventory."];
    return result;
  }

  // A permanent resident's meal plan, edited from the Meals workspace. Narrow
  // in the same way the residency plan is: which meals, the seating they start
  // from, and a note. Never touches the resident's name or active dates.
  async function saveResidentMealPlan(payload) {
    const actor = ensureApproved();
    const residentId = clean(payload?.residentId, 100);
    const reference = doc(db, "permanentResidents", residentId);
    if (!(await getDoc(reference)).exists()) throw new Error("This resident no longer exists.");
    const meals = Array.isArray(payload?.meals) ? payload.meals.filter(meal => MEALS.includes(meal)) : [];
    if (!meals.length) throw new Error("Choose at least one meal.");
    const batch = writeBatch(db);
    batch.update(reference, {
      meals,
      defaultSeating: mealSeating(payload?.seating),
      mealNote: clean(payload?.note, 500),
      updatedAt: Timestamp.now(),
      updatedBy: actor
    });
    await writeAuditBatch(batch, actor, "permanentResident", residentId, "resident-meals", ["meals", "defaultSeating", "mealNote"]);
    await batch.commit();
    invalidate();
    return { residentId, meals };
  }

  // An away period suspends a person's meals between two dates. It touches
  // nothing else about the stay — the room stays theirs and the residency
  // continues either side.
  async function saveMealAbsence(payload) {
    const actor = ensureApproved();
    const subjectType = payload?.subjectType === "permanentResident" ? "permanentResident" : "guest";
    const subjectId = clean(payload?.subjectId, 100);
    const fromKey = clean(payload?.fromKey, 20);
    const toKey = clean(payload?.toKey, 20);
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;
    if (!subjectId) throw new Error("This person no longer exists.");
    if (!dateShape.test(fromKey)) throw new Error("Give the first day away.");
    // A blank last day means the absence runs on until someone says otherwise
    // — the case where nobody yet knows when they are back. absenceOn already
    // reads an empty toKey that way, so only this gate needed relaxing.
    if (toKey && !dateShape.test(toKey)) throw new Error("That last day away is not a date.");
    if (toKey && toKey < fromKey) throw new Error("The last day away cannot be before the first.");
    const id = clean(payload?.absenceId, 100) || `${subjectType}--${subjectId}--${fromKey}`;
    const batch = writeBatch(db);
    batch.set(doc(db, "mealAbsences", id), {
      subjectType, subjectId, fromKey, toKey,
      note: clean(payload?.note, 300),
      updatedAt: Timestamp.now(), updatedBy: actor
    });
    await writeAuditBatch(batch, actor, "mealAbsence", id, "set", ["fromKey", "toKey"]);
    await batch.commit();
    invalidate();
    return { absenceId: id, fromKey, toKey };
  }

  async function deleteMealAbsence(absenceId) {
    const actor = ensureApproved();
    const id = clean(absenceId, 100);
    const reference = doc(db, "mealAbsences", id);
    if (!(await getDoc(reference)).exists()) throw new Error("This away period no longer exists.");
    const batch = writeBatch(db);
    batch.delete(reference);
    await writeAuditBatch(batch, actor, "mealAbsence", id, "delete", ["document"]);
    await batch.commit();
    invalidate();
    return { absenceId: id, deleted: true };
  }

  // The residency meal plan — which meals the stay covers, the seating it
  // starts from, and a note. Scoped to the visit alone: it never touches the
  // stay's dates, rooms or travel.
  async function saveResidencyMealPlan(payload) {
    const actor = ensureApproved();
    const visitId = clean(payload?.visitId, 100);
    const reference = doc(db, "visits", visitId);
    const snapshot = await getDoc(reference);
    if (!snapshot.exists()) throw new Error("This visit no longer exists.");
    const meals = Array.isArray(payload?.meals) ? payload.meals.filter(meal => MEALS.includes(meal)) : [];
    if (!meals.length) throw new Error("Choose at least one meal.");
    const batch = writeBatch(db);
    batch.update(reference, {
      residencyMeals: meals,
      diningSeating: mealSeating(payload?.seating, ""),
      residencyMealNote: clean(payload?.note, 500),
      updatedAt: Timestamp.now(),
      updatedBy: actor
    });
    await writeAuditBatch(batch, actor, "visit", visitId, "residency-meals", ["residencyMeals", "diningSeating", "residencyMealNote"]);
    await batch.commit();
    invalidate();
    return { visitId, meals };
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
      if (action === "deleteVisit") return deleteVisit(extra.visitId);
      if (action === "deleteTrip") return deleteTrip(extra.tripId);
      if (action === "deleteMeeting") return deleteMeeting(extra.meetingId);
      if (action === "deleteMealOverride") return deleteMealOverride(extra.overrideId);
      if (action === "upsertMealOverride") return upsertMealOverride(extra.payload || {});
      if (action === "setMealSeatingFrom") return setMealSeatingFrom(extra.payload || {});
      if (action === "saveResidencyMealPlan") return saveResidencyMealPlan(extra.payload || {});
      if (action === "auditResidentMerge") return auditResidentMerge();
      if (action === "migrateResidentsToGuests") return migrateResidentsToGuests(extra.options || {});
      if (action === "migrateResidentRooms") return migrateResidentRooms(extra.options || {});
      if (action === "saveResidentMealPlan") return saveResidentMealPlan(extra.payload || {});
      if (action === "saveMealAbsence") return saveMealAbsence(extra.payload || {});
      if (action === "deleteMealAbsence") return deleteMealAbsence(extra.absenceId);
      if (action === "saveMealSchedule") return saveMealSchedule(extra.payload || {});
      if (action === "deleteMealSchedule") return deleteMealSchedule(extra.scheduleId);
      if (action === "savePermanentResident") return savePermanentResident(extra.payload || {});
      if (action === "deletePermanentResident") return deletePermanentResident(extra.residentId);
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
