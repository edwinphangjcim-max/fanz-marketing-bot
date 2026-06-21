const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Just try one pattern and capture the full error
const user = 'postgres';
const host = `db.${projectRef}.supabase.co`;
const port = 5432;
const connStr = `postgresql://${user}:${encodeURIComponent(key)}@${host}:${port}/postgres`;

try {
  console.log(`Trying ${user}@${host}:${port}...`);
  const out = execSync(
    `psql "${connStr}" -c "ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS review_notes TEXT;" -t 2>&1`,
    { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }
  );
  console.log('SUCCESS:', out);
} catch (e) {
  // Print the full error
  console.log('stdout:', e.stdout?.toString().substring(0, 500));
  console.log('stderr:', e.stderr?.toString().substring(0, 500));
  console.log('message:', e.message?.substring(0, 500));
  console.log('code:', e.code);
}