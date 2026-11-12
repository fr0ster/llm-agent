import type {
  IRagRoleAdmin,
  IRagRoleCheck,
  RagAccess,
  RagCollectionOwner,
} from '../../index.js';
import { testRagAccess } from '../../testing/rag-access-testing.js';
export const access: RagAccess = testRagAccess();
export const check: IRagRoleCheck = access.roles;
export const admin: IRagRoleAdmin = testRagAccess().roleAdmin;
// @ts-expect-error Roles are not owners.
export const roleOwner: RagCollectionOwner = { scope: 'role', roleId: 'r' };
// @ts-expect-error Runtime access cannot manage roles.
access.roles.createRole({ roleId: 'r', name: 'R' });
