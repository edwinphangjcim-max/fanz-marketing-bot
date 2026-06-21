const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Try pooler with full error capture
const attempts = [
  { user: `postgres.${projectRef}`, host: 'aws-0-ap-southeast-1.pooler.supabase.com', port: 6543 },
  { user: 'postgres', host: 'aws-0-ap-southeast-1.pooler.supabase.com', port: 6543 },
];

for (const { user, host, port } of attempts) {
  const connStr = `postgresql://${user}:${encodeURIComponent(key)}@${host}:${port}/postgres?sslmode=require`;
  try {
    console.log(`Trying ${user}@${host}:${port}...`);
    const out = execSync(
      `PGPASSWORD="" psql "postgresql://${user}:@${host}:${port}/postgres?sslmode=require" -c "SELECT 1" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PGPASSWORD: key } }
    );
    console.log('CONNECTED:', out.toString().substring(0, 200));
    
    // Add column
    const out2 = execSync(
      `PGPASSWORD="${key}" psql "postgresql://${user}@${host}:${port}/postgres?sslmode=require" -c "ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS review_notes TEXT;" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PGPASSWORD: key } }
    );
    console.log('ALTER:', out2.toString().substring(0, 200));
    
    // Verify
    const out3 = execSync(
      `PGPASSWORD="${key}" psql "postgresql://${user}@${host}:${port}/postgres?sslmode=require" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar' AND column_name = 'review_notes';" -t 2>&1`,
      { timeout: 15000, shell: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PGPASSWORD: key } }
    );
    console.log('VERIFY:', out3.toString().substring(0, 200));
    process.exit(0);
  } catch (e) {
    console.log('Error for', `${user}@${host}:${port}:`);
    console.log('  stdout:', e.stdout?.toString().substring(0, 300) || '(none)');
    console.log('  stderr:', e.stderr?.toString().substring(0, 300) || '(none)');
  }
}
console.log('All attempts failed');