const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Pooler host should use project-ref.pooler.supabase.com
const host = `${projectRef}.pooler.supabase.com`;

// Try both session mode (5432) and transaction mode (6543)
const attempts = [
  { user: 'postgres', host: host, port: 5432, desc: 'session mode' },
  { user: 'postgres', host: host, port: 6543, desc: 'transaction mode' },
];

for (const { user, host, port, desc } of attempts) {
  try {
    console.log(`Trying ${user}@${host}:${port} (${desc})...`);
    const out = execSync(
      `PGPASSWORD="${key}" psql "postgresql://${user}@${host}:${port}/postgres?sslmode=require" -c "SELECT 1 AS ok" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }
    );
    console.log('CONNECTED:', out.toString().trim());
    
    // Add column
    const out2 = execSync(
      `PGPASSWORD="${key}" psql "postgresql://${user}@${host}:${port}/postgres?sslmode=require" -c "ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS review_notes TEXT;" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }
    );
    console.log('ALTER TABLE result:', out2.toString().trim());
    
    // Verify
    const out3 = execSync(
      `PGPASSWORD="${key}" psql "postgresql://${user}@${host}:${port}/postgres?sslmode=require" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar' AND column_name = 'review_notes';" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }
    );
    console.log('Column check:', out3.toString().trim());
    if (out3.toString().trim().includes('review_notes')) {
      console.log('✓ review_notes column successfully added!');
    }
    
    process.exit(0);
  } catch (e) {
    console.log('Error:', e.stdout?.toString().substring(0, 300) || e.stderr?.toString().substring(0, 300) || e.message.substring(0, 300));
  }
}
console.log('All pooler attempts failed');