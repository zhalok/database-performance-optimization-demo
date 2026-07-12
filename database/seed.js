const { Client } = require("pg");

const busCompanies = [
  "Green Line",
  "Hanif",
  "Shyamoli",
  "Shohagh",
  "SR",
  // "Desh",
  // "Saintmartin",
  // "Ena",
  // "Silk Line",
  // "Sakura",
  // "Eagle",
  // "Royal",
  // "Agamony",
  // "Tuba Line",
  // "London",
  // "Star Line",
  // "Blue Line",
  // "Diganta",
  // "AK",
  // "Unique",
  // "Saudia",
  // "TR",
  // "Nabil",
  // "Bablu",
  // "Rozina"
];

const bdDistricts = [
  // Barishal Division
  "Barguna",
  "Barishal",
  "Bhola",
  "Jhalokati",
  "Patuakhali",
  "Pirojpur",

  // Chattogram Division
  "Bandarban",
  "Brahmanbaria",
  "Chandpur",
  "Chattogram",
  "Cumilla",
  "Cox's Bazar",
  "Feni",
  "Khagrachhari",
  "Lakshmipur",
  "Noakhali",
  "Rangamati",

  // Dhaka Division
  "Dhaka",
  "Faridpur",
  "Gazipur",
  "Gopalganj",
  "Kishoreganj",
  "Madaripur",
  "Manikganj",
  "Munshiganj",
  "Narayanganj",
  "Narsingdi",
  "Rajbari",
  "Shariatpur",
  "Tangail",

  // Khulna Division
  "Bagerhat",
  "Chuadanga",
  "Jashore",
  "Jhenaidah",
  "Khulna",
  "Kushtia",
  "Magura",
  "Meherpur",
  "Narail",
  "Satkhira",

  // Mymensingh Division
  "Jamalpur",
  "Mymensingh",
  "Netrokona",
  "Sherpur",

  // Rajshahi Division
  "Bogra",
  "Joypurhat",
  "Naogaon",
  "Natore",
  "Chapai Nawabganj",
  "Pabna",
  "Rajshahi",
  "Sirajganj",

  // Rangpur Division
  "Dinajpur",
  "Gaibandha",
  "Kurigram",
  "Lalmonirhat",
  "Nilphamari",
  "Panchagarh",
  "Rangpur",
  "Thakurgaon",

  // Sylhet Division
  "Habiganj",
  "Moulvibazar",
  "Sunamganj",
  "Sylhet"
];

const SEATS_PER_TRIP = 50;
const DAYS = Number(process.env.SEED_DAYS) || 3; // trips for the next N days
const HUB = "Dhaka"; // only generate routes that start or end at this hub
const SLOT_MINUTES = Number(process.env.SEED_SLOT_MINUTES) || 30; // a trip every N minutes
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;
const TICKET_PRICE = 100;
const COLUMNS_PER_ROW = 8; // seat_no, from_location, to_location, bus_company, is_booked, travel_date, travel_time, price
const ROWS_PER_BATCH = 5000; // 5000 * 8 = 40000 params, under the 65535 limit

function seatNo(n) {
  // 100 seats laid out as A1..A25, B1..B25, C1..C25, D1..D25
  const row = String.fromCharCode(65 + Math.floor((n - 1) / 25));
  const col = ((n - 1) % 25) + 1;
  return `${row}${col}`;
}

// The next `numDays` calendar days (including today) as YYYY-MM-DD strings.
function travelDates(numDays) {
  const dates = [];
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  for (let d = 0; d < numDays; d++) {
    const dt = new Date(base);
    dt.setDate(base.getDate() + d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

// All departure times in a day at `slotMinutes` intervals as HH:MM strings.
function timeSlots(slotMinutes) {
  const slots = [];
  for (let m = 0; m < 24 * 60; m += slotMinutes) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push(`${hh}:${mm}`);
  }
  return slots;
}

async function flush(client, rows) {
  if (rows.length === 0) return;

  const placeholders = [];
  const values = [];
  let p = 0;

  for (const row of rows) {
    const ph = [];
    for (const value of row) {
      ph.push(`$${++p}`);
      values.push(value);
    }
    placeholders.push(`(${ph.join(", ")})`);
  }

  const sql =
    `insert into tickets (seat_no, from_location, to_location, bus_company, is_booked, travel_date, travel_time, price) values ` +
    placeholders.join(", ");

  await client.query(sql, values);
}

async function seed() {
  const client = new Client({
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT) || 5432,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "postgres",
  });

  await client.connect();
  console.log("Connected. Generating tickets...");

  const dates = travelDates(DAYS);
  const slots = timeSlots(SLOT_MINUTES);

  const routes = 2 * (bdDistricts.length - 1); // HUB -> others and others -> HUB
  const totalTrips =
    dates.length * slots.length * busCompanies.length * routes;
  const totalRows = totalTrips * SEATS_PER_TRIP;
  console.log(
    `Planned: ${dates.length} days x ${slots.length} slots/day x ${busCompanies.length} companies x ${routes.toLocaleString()} routes = ${totalTrips.toLocaleString()} trips`
  );
  console.log(
    `         x ${SEATS_PER_TRIP} seats = ${totalRows.toLocaleString()} tickets`
  );

  let buffer = [];
  let inserted = 0;
  const start = Date.now();

  // Seat is the outermost loop so that each trip's seats are scattered far
  // apart in the table. For one seat we emit every
  // (date, time, company, from, to) combination before moving on to the next.
  for (let seat = 1; seat <= SEATS_PER_TRIP; seat++) {
    for (const date of dates) {
      for (const time of slots) {
        for (const company of busCompanies) {
          for (const from of bdDistricts) {
            for (const to of bdDistricts) {
              if (from === to) continue; // no trip from a city to itself
              if (from !== HUB && to !== HUB) continue; // only HUB routes

              buffer.push([seatNo(seat), from, to, company, false, date, time, TICKET_PRICE]);

              if (buffer.length >= ROWS_PER_BATCH) {
                await flush(client, buffer);
                inserted += buffer.length;
                buffer = [];
                process.stdout.write(
                  `\rInserted ${inserted.toLocaleString()} / ${totalRows.toLocaleString()}`
                );
              }
            }
          }
        }
      }
    }
  }

  await flush(client, buffer);
  inserted += buffer.length;

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `\nDone. Inserted ${inserted.toLocaleString()} tickets in ${seconds}s.`
  );

  await client.end();
}

seed().catch((err) => {
  console.error("\nSeeding failed:", err);
  process.exit(1);
});
