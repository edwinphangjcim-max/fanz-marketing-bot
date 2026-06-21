const { execSync } = require('child_process');
const key = process.env.SUPABASE_SERVICE_KEY;
const projectRef = 'ipozfadochzlljkxetcs';

// Try direct database host
const hosts = [
  `db.${projectRef}.supabase.co:5432`,
  `aws-0-ap-southeast-1.pooler.supabase.com:5432`,
  `aws-0-ap-southeast-1.pooler.supabase.com:6543`,
];

// Try different user formats
const users = [
  `postgres.${projectRef}`,
  `postgres`,
];

for (const host of hosts) {
  for (const user of users) {
    const connStr = `postgresql://${user}:${encodeURIComponent(key)}@${host}/postgres`;
    try {
      console.log(`Trying ${user}@${host}...`);
      const out = execSync(
        `psql "${connStr}" -c "SELECT 1 AS ok" -t 2>&1`,
        { timeout: 8000, shell: true, maxBuffer: 1024 * 1024 }
      );
      console.log('SUCCESS!', out.toString().trim());
      
      // Now get columns
      const out2 = execSync(
        `psql "${connStr}" -c "SELECT column_name FROM information_schema.columns WHERE table_name = 'content_calendar'" -t 2>&1`,
        { timeout: 8000, shell: true, maxBuffer: 1024 * 1024 }
      );
      console.log('Columns:', out2.toString().trim());
      process.exit(0);
    } catch (e) {
      const msg = e.message.substring(0, 150);
      if (!msg.includes('FATAL') && !msg.includes('timeout') && !msg.includes('ENOTFOUND')) {
        console.log('  Error:', msg);
      }
    }
  }
}
console.log('All connection attempts failed');