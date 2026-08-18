/**
 * Sign-in page of the authentication shell.
 *
 * Exports `Login`, lazily mounted at `/auth/login` by `@/routes/authentication`
 * and rendered by `Authentication.tsx`, which supplies the page background,
 * logo, `AuthMetaBootProvider` and route transitions around it.
 *
 * Frames its content with the shared `AuthInsider` layout plus an
 * `AuthInsiderCard`, drives `LoginForm` through Formik with `LoginSchema`, and
 * submits credentials via the `useAuthLogin` mutation, surfacing failures as
 * toasts. The footer links to `/auth/register` and `/auth/send_reset_password`,
 * hiding the sign-up link when `useAuthMetaBoot` reports `signupDisabled`.
 */
import { Formik, FormikHelpers } from 'formik';
import { Link } from 'react-router-dom';
import {
  AuthCardHeading,
  AuthCardSubtitle,
  AuthCardTitle,
  AuthFooterLinks,
  AuthFooterLink,
  AuthInsiderCard,
} from './_components';
import { useAuthMetaBoot } from './AuthMetaBoot';
import { LoginForm } from './LoginForm';
import {
  LoginSchema,
  transformLoginErrorsToToasts,
  LoginValues,
} from './utils';
import type { ApiError } from 'openapi-typescript-fetch';
import { AppToaster as Toaster, FormattedMessage as T } from '@/components';
import { AuthInsider } from '@/containers/Authentication/AuthInsider';
import { useAuthLogin } from '@/hooks/query';

const initialValues: LoginValues = {
  crediential: '',
  password: '',
  keepLoggedIn: false,
};

/**
 * Login page.
 */
export function Login() {
  const { mutateAsync: loginMutate } = useAuthLogin();

  const handleSubmit = (
    values: LoginValues,
    { setSubmitting }: FormikHelpers<LoginValues>,
  ) => {
    loginMutate({
      email: values.crediential,
      password: values.password,
    }).catch((response: ApiError) => {
      const toastMessages = transformLoginErrorsToToasts(response.data);

      toastMessages.forEach((toastMessage) => {
        Toaster.show(toastMessage);
      });
      setSubmitting(false);
    });
  };

  return (
    <AuthInsider>
      <AuthInsiderCard>
        <AuthCardHeading>
          <AuthCardTitle>
            <T id={'log_in'} />
          </AuthCardTitle>
          <AuthCardSubtitle>
            <T id={'login_welcome_back_subheading'} />
          </AuthCardSubtitle>
        </AuthCardHeading>

        <Formik
          initialValues={initialValues}
          validationSchema={LoginSchema}
          onSubmit={handleSubmit}
          component={LoginForm}
        />
      </AuthInsiderCard>

      <LoginFooterLinks />
    </AuthInsider>
  );
}

function LoginFooterLinks() {
  const { signupDisabled } = useAuthMetaBoot();

  return (
    <AuthFooterLinks>
      {!signupDisabled && (
        <AuthFooterLink>
          <T id={'dont_have_an_account'} />{' '}
          <Link to={'/auth/register'}>
            <T id={'sign_up'} />
          </Link>
        </AuthFooterLink>
      )}
      <AuthFooterLink>
        <Link to={'/auth/send_reset_password'}>
          <T id={'forgot_my_password'} />
        </Link>
      </AuthFooterLink>
    </AuthFooterLinks>
  );
}
