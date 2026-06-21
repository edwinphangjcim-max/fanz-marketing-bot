const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';
const region = 'ap-southeast-1';
const connStr = `postgresql://postgres.${projectRef}:${encodeURIComponent(key)}@aws-0-${region}.pooler.supabase.com:6543/postgres`;

try {
  const out = execSync(
    `psql "${connStr}" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar'" -t`,
    { timeout: 15000, shell: true, maxBuffer: 1024 * 1024 }
  );
  console.log('Columns in content_calendar:');
  console.log(out.toString().trim());
} catch (e) {
  console.log('Connection error:', e.message.substring(0, 300));
  if (e.stderr) console.log('stderr:', e.stderr.toString().substring(0, 200));
}
