import { test, expect, Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import { clearLocalStorage, newUnauthenticatedPage } from './_utils';

// This spec exercises the login/register UI itself, so it must start each
// test without the shared onboarded session.
test.use({ storageState: undefined });

let authPage: Page;

test.describe('authentication', () => {
  test.beforeAll(async ({ browser }) => {
    authPage = await newUnauthenticatedPage(browser);
  });
  test.afterAll(async () => {
    await authPage.close();
  });
  test.afterEach(async ({ context }) => {
    context.clearCookies();
    await clearLocalStorage(authPage);
  });

  test.describe('login', () => {
    test.beforeEach(async () => {
      await authPage.goto('/auth/login');
    });
    test('should show the login page.', async () => {
      await expect(authPage.locator('body')).toContainText(
        "Don't have an account? Sign up"
      );
    });
    test('should email and password be required.', async () => {
      await authPage.getByRole('button', { name: 'Log in' }).click();

      await expect(authPage.locator('form')).toContainText(
        'Email is a required field'
      );
      await expect(authPage.locator('form')).toContainText(
        'Password is a required field'
      );
    });
    test('should go to the register page when click on sign up link', async () => {
      await authPage.getByRole('link', { name: 'Sign up' }).click();
      await expect(authPage.url()).toContain('/auth/register');
    });
    test('should the email or password is not correct.', async () => {
      await authPage.getByLabel('Email Address').click();
      await authPage.getByLabel('Email Address').fill(faker.internet.email());

      await authPage.getByLabel('Password').click();
      await authPage.getByLabel('Password').fill(faker.internet.password());

      await authPage.getByRole('button', { name: 'Log in' }).click();

      await expect(authPage.locator('body')).toContainText(
        'The email and password you entered did not match our records.'
      );
    });

    test('should the email and password inputs carry autocomplete hints.', async () => {
      await expect(authPage.getByLabel('Email Address')).toHaveAttribute(
        'autocomplete',
        'email'
      );
      await expect(authPage.getByLabel('Password')).toHaveAttribute(
        'autocomplete',
        'current-password'
      );
    });

    test('should toggle the password visibility.', async () => {
      const password = authPage.getByLabel('Password');
      await password.fill('secret-value');

      await expect(password).toHaveAttribute('type', 'password');

      await authPage.getByTestId('login-password-revealer').click();
      await expect(password).toHaveAttribute('type', 'text');
      await expect(password).toHaveValue('secret-value');

      await authPage.getByTestId('login-password-revealer').click();
      await expect(password).toHaveAttribute('type', 'password');
    });

    test('should associate the validation message with its input.', async () => {
      await authPage.getByRole('button', { name: 'Log in' }).click();

      const email = authPage.getByLabel('Email Address');
      await expect(email).toHaveAttribute('aria-invalid', 'true');
      await expect(email).toHaveAttribute(
        'aria-describedby',
        'crediential-error'
      );
      await expect(authPage.locator('#crediential-error')).toHaveText(
        'Email is a required field'
      );
    });
  });

  test.describe('login presentation', () => {
    // These specs stub `/api/auth/signin` so the submitting/error presentation
    // is deterministic; they run on their own page so the stubs never leak into
    // the specs above.
    const stubSignin = async (page: Page, delayMs: number) => {
      await page.route('**/api/auth/signin', async (route) => {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            statusCode: 401,
            error: 'Unauthorized',
            message: 'Invalid email or password',
            code: 'INVALID_DETAILS',
          }),
        });
      });
    };

    test('should the submit button show a loading state while signing in.', async ({
      browser,
    }) => {
      const page = await newUnauthenticatedPage(browser);
      await stubSignin(page, 3000);
      await page.goto('/auth/login');

      await page.getByLabel('Email Address').fill(faker.internet.email());
      await page.getByLabel('Password').fill(faker.internet.password());
      await page.getByRole('button', { name: 'Log in' }).click();

      const submit = page.getByTestId('login-submit');
      await expect(submit).toHaveClass(/bp4-loading/);
      await expect(submit).toBeDisabled();

      await expect(page.locator('body')).toContainText(
        'The email and password you entered did not match our records.'
      );
      await expect(submit).not.toHaveClass(/bp4-loading/);
      await expect(submit).toBeEnabled();

      await page.close();
    });

    test('should submit the form with the enter key.', async ({ browser }) => {
      const page = await newUnauthenticatedPage(browser);
      await stubSignin(page, 0);
      await page.goto('/auth/login');

      await page.getByLabel('Email Address').fill(faker.internet.email());
      await page.getByLabel('Password').fill(faker.internet.password());
      await page.getByLabel('Password').press('Enter');

      await expect(page.locator('body')).toContainText(
        'The email and password you entered did not match our records.'
      );
      await page.close();
    });

    test('should be usable on a mobile viewport without horizontal overflow.', async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      await page.goto('/auth/login');
      await page.getByRole('button', { name: 'Log in' }).waitFor();

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

      // The whole form stays inside the viewport and remains operable.
      const card = page.locator('form');
      const box = await card.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);

      await page.getByLabel('Email Address').fill('accountant@bigcapital.app');
      await expect(page.getByLabel('Email Address')).toHaveValue(
        'accountant@bigcapital.app'
      );
      await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();

      await context.close();
    });
  });

  test.describe('register', () => {
    test.beforeEach(async () => {
      await authPage.goto('/auth/register');
    });
    test('should first name, last name, email and password be required.', async () => {
      await authPage.getByRole('button', { name: 'Register' }).click();

      await expect(authPage.locator('form')).toContainText(
        'First name is a required field'
      );
      await expect(authPage.locator('form')).toContainText(
        'Last name is a required field'
      );
      await expect(authPage.locator('form')).toContainText(
        'Email is a required field'
      );
      await expect(authPage.locator('form')).toContainText(
        'Password is a required field'
      );
    });
    test('should signup successfully.', async () => {
      const form = authPage.locator('form');
      await form.getByLabel('First Name').click();
      await form.getByLabel('First Name').fill(faker.person.firstName());

      await form.getByLabel('Email').click();
      await form.getByLabel('Email').fill(faker.internet.email());

      await form.getByLabel('Last Name').click();
      await form.getByLabel('Last Name').fill(faker.person.lastName());

      await form.getByLabel('Password').click();
      await form.getByLabel('Password').fill(faker.internet.password());

      await authPage.getByRole('button', { name: 'Register' }).click();

      await expect(authPage.locator('h1')).toContainText(
        'Register a New Organization now!'
      );
    });
  });

  test.describe('reset password', () => {
    test.beforeAll(async ({ browser }) => {
      authPage = await newUnauthenticatedPage(browser);
    });
    test.afterAll(async () => {
      await authPage.close();
    });
    test.beforeEach(async () => {
      await authPage.goto('/auth/send_reset_password');
    });
    test('should email be required.', async () => {
      await authPage.getByRole('button', { name: 'Reset Password' }).click();
      await expect(authPage.locator('form')).toContainText(
        'Email is a required field'
      );
    });

    test('should label the new and confirm password fields distinctly.', async () => {
      // The page renders regardless of the token; the token is only read on
      // submit, so a dummy one is enough to inspect the form labels.
      await authPage.goto('/auth/reset_password/dummy-token');

      const form = authPage.locator('form');
      const newPassword = form.getByLabel('New Password', { exact: true });
      const confirmPassword = form.getByLabel('Confirm password', {
        exact: true,
      });

      await expect(newPassword).toHaveAttribute('name', 'password');
      await expect(confirmPassword).toHaveAttribute('name', 'confirm_password');
    });
  });
});
