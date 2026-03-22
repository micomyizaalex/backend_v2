const { Pool } = require('pg');
require('dotenv/config');

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: false },
});

async function main() {
	const client = await pool.connect();

	try {
		const constraintResult = await client.query(`
			SELECT conname, contype
			FROM pg_constraint
			WHERE conrelid = 'ticket_scan_logs'::regclass
			  AND conname = 'ticket_scan_logs_schedule_id_fkey'
		`);

		if (!constraintResult.rows.length) {
			console.log('FK constraint ticket_scan_logs_schedule_id_fkey does not exist - nothing to do.');
			return;
		}

		console.log('Found constraint:', constraintResult.rows[0]);
		await client.query('ALTER TABLE ticket_scan_logs DROP CONSTRAINT ticket_scan_logs_schedule_id_fkey');
		console.log('Dropped ticket_scan_logs_schedule_id_fkey successfully.');

		const indexResult = await client.query(`
			SELECT indexname
			FROM pg_indexes
			WHERE tablename = 'ticket_scan_logs'
			  AND indexname = 'idx_ticket_scan_logs_schedule_id'
		`);

		console.log('schedule_id index present:', indexResult.rows.length > 0);
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error.message);
	pool.end();
	process.exitCode = 1;
});