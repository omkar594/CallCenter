/**
 * Middleware to extract and format tenant isolation context.
 * Super Admins bypass RLS by setting tenantId to null.
 * Client Admins, Mentors, TLs, and Agents have their tenantId bound to their token tenant_id.
 */
export function injectTenantContext(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'User context not found' });
  }

  // Super Admin bypasses RLS
  if (req.user.role === 'super_admin') {
    req.tenantId = null;
  } else {
    // If not super_admin, they MUST have a tenant_id
    if (!req.user.tenant_id) {
      return res.status(400).json({ error: 'Tenant context missing in user token' });
    }
    req.tenantId = req.user.tenant_id;
  }
  
  next();
}
