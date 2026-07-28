import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Execute a database query within a transaction setting the local tenant_id context for RLS.
 * If tenantId is null, it bypasses tenant-level filtering (useful for Super Admin or background jobs).
 * 
 * @param {string|null} tenantId - The UUID of the tenant or null for super admin bypass.
 * @param {string} text - SQL query text.
 * @param {Array} params - Query parameters.
 * @returns {Promise<Object>} pg result object.
 */
export async function executeTenantQuery(tenantId, text, params = []) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (tenantId) {
      // Set the session variable for PostgreSQL Row-Level Security
      await client.query('SELECT set_config(\'app.current_tenant_id\', $1, true)', [tenantId]);
    } else {
      // Reset session variable to allow global database access (Super Admin)
      await client.query('SELECT set_config(\'app.current_tenant_id\', \'\', true)');
    }
    
    const res = await client.query(text, params);
    await client.query('COMMIT');
    return res;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
