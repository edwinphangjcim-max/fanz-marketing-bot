const { Client } = require('pg');

const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Try different connection patterns
const configs = [
  // Direct connection
  { user: 'postgres', host: `db.${projectRef}.supabase.co`, database: 'postgres', password: key, port: 5432, ssl: { rejectUnauthorized: false } },
  // Pooler session mode
  { user: 'postgres', host: `aws-0-ap-southeast-1.pooler.supabase.com`, database: 'postgres', password: key, port: 5432, ssl: { rejectUnauthorized: false } },
  // Pooler transaction mode
  { user: 'postgres', host: `aws-0-ap-southeast-1.pooler.supabase.com`, database: 'postgres', password: key, port: 6543, ssl: { rejectUnauthorized: false } },
];

async function tryConnect(config, label) {
  const client = new Client(config);
  try {
    console.log(`Trying ${label}...`);
    await client.connect();
    console.log('  Connected!');
    
    const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar'");
    console.log('  Columns:', res.rows.map(r => r.column_name).join(', '));
    
    // Add the review_notes column
    await client.query("ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS review_notes TEXT");
    console.log('  Added review_notes column');
    
    // Verify
    const res2 = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar' AND column_name = 'review_notes'");
    if (res2.rows.length > 0) {
      console.log('  ✓ review_notes column confirmed!');
    }
    
    await client.end();
    process.exit(0);
  } catch (e) {
    console.log(`  Failed:`, e.message.substring(0, 200));
    try { await client.end(); } catch (_) {}
  }
}

(async () => {
  for (let i = 0; i < configs.length; i++) {
    await tryConnect(configs[i], `pattern ${i + 1}`);
  }
  console.log('All connection attempts failed');
})();