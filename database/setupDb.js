import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/callcenter';

async function run() {
  console.log('Starting Multi-Tenant Contact Center database setup...');

  // Parse connection string to get connection details for default database connection
  const urlParts = new URL(connectionString);
  const dbName = urlParts.pathname.substring(1);
  
  // Create connection to default database to check/create target database
  const defaultUrl = `${urlParts.protocol}//${urlParts.username}:${urlParts.password}@${urlParts.host}/postgres`;
  
  const defaultClient = new pg.Client({ connectionString: defaultUrl });
  try {
    await defaultClient.connect();
    const dbCheck = await defaultClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
    if (dbCheck.rows.length === 0) {
      console.log(`Database '${dbName}' does not exist. Creating...`);
      // Run CREATE DATABASE (can't run inside transaction, so execute outside pool)
      await defaultClient.query(`CREATE DATABASE ${dbName}`);
      console.log(`Database '${dbName}' created successfully.`);
    } else {
      console.log(`Database '${dbName}' already exists.`);
    }
  } catch (err) {
    console.warn('Warning: Failed to verify/create database using default connection:', err.message);
  } finally {
    try {
      await defaultClient.end();
    } catch (e) {}
  }

  // Connect to target database
  console.log(`Connecting to database '${dbName}'...`);
  const client = new pg.Client({ connectionString });
  
  try {
    await client.connect();
    
    // Read and run schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    console.log(`Reading schema from ${schemaPath}...`);
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schemaSql);
    console.log('Database schema successfully initialized.');

    // Read and run seed.sql
    const seedPath = path.join(__dirname, 'seed.sql');
    console.log(`Reading seed data from ${seedPath}...`);
    const seedSql = fs.readFileSync(seedPath, 'utf8');
    await client.query(seedSql);
    console.log('Demo seed data successfully loaded.');

    // Create a new custom demo account as requested by the user
    const demoUsername = 'demo_agent';
    const demoPassword = 'password123';
    const demoHash = bcrypt.hashSync(demoPassword, 10);
    
    // Check if demo user already exists
    const userCheck = await client.query(`SELECT id FROM users WHERE username = $1`, [demoUsername]);
    if (userCheck.rows.length === 0) {
      console.log(`Creating demo agent account: username='${demoUsername}', password='${demoPassword}'...`);
      // HDFC Tenant ID: a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11
      // Reporting TL ID: b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13
      const insertUser = await client.query(`
        INSERT INTO users (tenant_id, username, password_hash, role, parent_id)
        VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', $1, $2, 'agent', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13')
        RETURNING id
      `, [demoUsername, demoHash]);

      const userId = insertUser.rows[0].id;

      // Initialize Agent Profile
      await client.query(`
        INSERT INTO agent_profiles (user_id, current_status, current_language)
        VALUES ($1, 'offline', 'English')
      `, [userId]);

      // Seed a few dummy bucket calls for this demo agent
      const now = new Date();
      const sla1 = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours SLA
      const sla2 = new Date(now.getTime() - 10 * 60 * 1000);     // Breached SLA (10 minutes ago)

      await client.query(`
        INSERT INTO buckets (tenant_id, agent_id, customer_number, customer_name, sla_deadline)
        VALUES 
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', $1, '+919876543210', 'Rahul Sharma', $2),
        ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', $1, '+919988776655', 'Priya Patel (Urgent)', $3)
      `, [userId, sla1, sla2]);

      console.log('Demo account and sample SLA bucket calls successfully generated.');
    } else {
      console.log(`Demo account '${demoUsername}' already exists.`);
    }

  } catch (error) {
    console.error('Error during database setup:', error.message);
  } finally {
    try {
      await client.end();
    } catch (e) {}
  }
}

run();
