import { defineAuth } from '@aws-amplify/backend';

/**
 * Email sign-up with verification. `platform-admin` membership is granted only
 * by scripts/bootstrap-admin.ts using deployment credentials; there is no
 * self-service promotion path.
 */
export const auth = defineAuth({
  loginWith: { email: true },
  userAttributes: {
    // Cognito "name" attribute carries the display name chosen at sign-up.
    fullname: { required: false, mutable: true },
  },
  groups: ['platform-admin'],
  multifactor: { mode: 'OPTIONAL', totp: true },
  accountRecovery: 'EMAIL_ONLY',
});
