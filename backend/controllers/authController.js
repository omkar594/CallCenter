import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { executeTenantQuery } from '../config/database.js';

export async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    // Look up user globally (Super Admin check requires no tenant ID filtering at query start)
    const userResult = await executeTenantQuery(null, `
      SELECT u.id, u.username, u.password_hash, u.role, u.tenant_id, u.parent_id, u.status, t.name as tenant_name 
      FROM users u
      LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.username = $1
    `, [username]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = userResult.rows[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'This user account is inactive' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Update agent status to 'login' in database (if user is an agent)
    if (user.role === 'agent') {
      await executeTenantQuery(user.tenant_id, `
        INSERT INTO agent_profiles (user_id, current_status, last_status_change)
        VALUES ($1, 'login', NOW())
        ON CONFLICT (user_id) DO UPDATE SET current_status = 'login', last_status_change = NOW()
      `, [user.id]);
    }

    // Generate JWT token containing roles, parent report hierarchy and tenant mapping
    const token = jwt.sign(
      {
        id: user.id,
        tenant_id: user.tenant_id,
        username: user.username,
        role: user.role,
        parent_id: user.parent_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenant_id: user.tenant_id,
        tenant_name: user.tenant_name
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
}

export async function logout(req, res) {
  const { id, role, tenant_id } = req.user;
  
  try {
    if (role === 'agent') {
      // Set agent profile status to offline
      await executeTenantQuery(tenant_id, `
        UPDATE agent_profiles SET current_status = 'offline', last_status_change = NOW() WHERE user_id = $1
      `, [id]);
    }
    
    res.json({ message: 'Logout successful' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Internal server error during logout' });
  }
}
