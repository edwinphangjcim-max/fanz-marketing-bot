const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Try all possible connection patterns
const patterns = [
  // Direct DB host
  { user: 'postgres', host: `db.${projectRef}.supabase.co`, port: 5432 },
  { user: `postgres.${projectRef}`, host: `db.${projectRef}.supabase.co`, port: 5432 },
  // Pooler session mode
  { user: 'postgres', host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 5432 },
  { user: `postgres.${projectRef}`, host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 5432 },
  // Pooler transaction mode
  { user: 'postgres', host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 6543 },
  { user: `postgres.${projectRef}`, host: `aws-0-ap-southeast-1.pooler.supabase.com`, port: 6543 },
  // Alternative region
  { user: 'postgres', host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 6543 },
  { user: `postgres.${projectRef}`, host: `aws-0-ap-southeast-2.pooler.supabase.com`, port: 6543 },
];

for (const { user, host, port } of patterns) {
  const connStr = `postgresql://${user}:${encodeURIComponent(key)}@${host}:${port}/postgres`;
  try {
    console.log(`Trying ${user}@${host}:${port}...`);
    const out = execSync(
      `psql "${connStr}" -c "SELECT 1 AS ok" -t 2>&1`,
      { timeout: 10000, shell: true, maxBuffer: 1024 * 1024 }
    );
    const result = out.toString().trim();
    console.log('  CONNECTED:', result);
    
    // Now add the column
    const out2 = execSync(
      `psql "${connStr}" -c "ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS review_notes TEXT;" -t 2>&1`,
      { timeout: 10000, shell: true, maxBuffer: 1024 * 1024 }
    );
    console.log('  ALTER TABLE:', out2.toString().trim());
    
    // Verify
    const out3 = execSync(
      `psql "${connStr}" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar' AND column_name = 'review_notes';" -t 2>&1`,
      { timeout: 10000, shell: true, maxBuffer: 1024 * 1024 }
    );
    console.log('  Column check:', out3.toString().trim());
    
    process.exit(0);
  } catch (e) {
    const lines = e.message.split('\n').filter(l => l.includes('FATAL') || l.includes('could not') || l.includes('timeout'));
    const msg = lines.length > 0 ? lines.join(' | ') : e.message.substring(0, 200);
    console.log('  Error:', msg);
  }
}
console.log('All connection attempts failed');