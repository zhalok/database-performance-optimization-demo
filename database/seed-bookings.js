const { Client } = require("pg");

const BOOKING_PERCENT = Number(process.env.SEED_BOOKING_PERCENT) || 20; // % of tickets to book
const USER_COUNT = Number(process.env.SEED_USER_COUNT) || 1000; // user_ids range 1..USER_COUNT
const BATCH_SIZE = Number(process.env.SEED_BOOKING_BATCH) || 5000;

function randomUserId() {
  return Math.floor(Math.random() * USER_COUNT) + 1;
}

async function flush(client, ticketIds) {
  if (ticketIds.length === 0) return;

  const placeholders = [];
  const values = [];
  let p = 0;

  for (const ticketId of ticketIds) {
    placeholders.push(`($${++p}, $${++p})`);
    values.push(randomUserId(), ticketId);
  }

  await client.query(
    `insert into bookings (user_id, ticket_id) values ${placeholders.join(", ")}`,
    values
  );

  await client.query(
    `update tickets set is_booked = true where id = any($1)`,
    [ticketIds]
  );
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
  console.log("Connected. Selecting tickets to book...");

  const { rows: countRows } = await client.query(
    `select count(*) from tickets where is_booked = false`
  );
  const available = Number(countRows[0].count);
  const target = Math.floor((available * BOOKING_PERCENT) / 100);
  console.log(
    `Available unbooked tickets: ${available.toLocaleString()}. Booking ~${BOOKING_PERCENT}% = ${target.toLocaleString()}.`
  );

  const cursor = await client.query(
    `select id from tickets where is_booked = false order by random() limit $1`,
    [target]
  );

  let buffer = [];
  let inserted = 0;
  const start = Date.now();

  for (const row of cursor.rows) {
    buffer.push(row.id);

    if (buffer.length >= BATCH_SIZE) {
      await flush(client, buffer);
      inserted += buffer.length;
      buffer = [];
      process.stdout.write(
        `\rBooked ${inserted.toLocaleString()} / ${target.toLocaleString()}`
      );
    }
  }

  await flush(client, buffer);
  inserted += buffer.length;

  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone. Booked ${inserted.toLocaleString()} tickets in ${seconds}s.`);

  await client.end();
}

seed().catch((err) => {
  console.error("\nSeeding failed:", err);
  process.exit(1);
});
