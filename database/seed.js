const { Client } = require("pg");

const busCompanies = [
  "Green Line",
  "Hanif",
  "Shyamoli",
  "Shohagh",
  "SR",
  "Desh",
  "Saintmartin",
  "Ena",
  "Silk Line",
  "Sakura",
  "Eagle",
  "Royal",
  "Agamony",
  "Tuba Line",
  "London",
  "Star Line",
  "Blue Line",
  "Diganta",
  "AK",
  "Unique",
  "Saudia",
  "TR",
  "Nabil",
  "Bablu",
  "Rozina"
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

const SEATS_PER_TRIP = 100;
const COLUMNS_PER_ROW = 5; // seat_no, from_location, to_location, bus_company, is_booked
const ROWS_PER_BATCH = 5000; // 5000 * 5 = 25000 params, well under the 65535 limit

function seatNo(n) {
  // 100 seats laid out as A1..A25, B1..B25, C1..C25, D1..D25
  const row = String.fromCharCode(65 + Math.floor((n - 1) / 25));
  const col = ((n - 1) % 25) + 1;
  return `${row}${col}`;
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
    `insert into tickets (seat_no, from_location, to_location, bus_company, is_booked) values ` +
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

  const totalTrips =
    busCompanies.length * bdDistricts.length * (bdDistricts.length - 1);
  const totalRows = totalTrips * SEATS_PER_TRIP;
  console.log(
    `Planned: ${totalTrips.toLocaleString()} trips x ${SEATS_PER_TRIP} seats = ${totalRows.toLocaleString()} tickets`
  );

  let buffer = [];
  let inserted = 0;
  const start = Date.now();

  for (const company of busCompanies) {
    for (const from of bdDistricts) {
      for (const to of bdDistricts) {
        if (from === to) continue; // no trip from a city to itself

        for (let seat = 1; seat <= SEATS_PER_TRIP; seat++) {
          buffer.push([seatNo(seat), from, to, company, false]);

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
