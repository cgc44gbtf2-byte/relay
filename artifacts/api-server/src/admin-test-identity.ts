export const TEST_USERNAME_PREFIX = "admin_access_test_";
export const TEST_EMAIL_DOMAIN = "example.com";

type ClerkTestUser = {
  username: string | null;
  emailAddresses: Array<{ emailAddress: string }>;
};

export function isAdminRegressionTestUser(user: ClerkTestUser): boolean {
  if (!user.username?.startsWith(TEST_USERNAME_PREFIX)) {
    return false;
  }

  return user.emailAddresses.some(
    ({ emailAddress }) =>
      emailAddress === `${user.username}@${TEST_EMAIL_DOMAIN}`,
  );
}