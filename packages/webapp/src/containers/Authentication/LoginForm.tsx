import { Button, Intent } from '@blueprintjs/core';
import { Tooltip2 } from '@blueprintjs/popover2';
import { Form, useField } from 'formik';
import React, { ReactNode, useState } from 'react';
import intl from 'react-intl-universal';
import styled from 'styled-components';
import { AuthSubmitButton } from './_components';
import { FFormGroup, FInputGroup, FCheckbox, T } from '@/components';

/**
 * Renders the field validation message as an assertive live region carrying a
 * stable id, so the input can point at it through `aria-describedby`.
 */
function useFieldError(name: string) {
  const [, meta] = useField(name);
  const hasError = Boolean(meta.touched && meta.error);
  const errorId = `${name}-error`;

  const helperText: ReactNode = hasError ? (
    <span id={errorId} role={'alert'}>
      {meta.error}
    </span>
  ) : (
    ''
  );

  return {
    hasError,
    helperText,
    inputProps: {
      'aria-invalid': hasError,
      'aria-describedby': hasError ? errorId : undefined,
    },
  };
}

/**
 * Login form.
 */
export function LoginForm({ isSubmitting }: { isSubmitting: boolean }) {
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const email = useFieldError('crediential');
  const password = useFieldError('password');

  // Handle password revealer changing.
  const handleLockClick = () => {
    setShowPassword(!showPassword);
  };

  // The accessible name deliberately avoids the word "password" so it does not
  // collide with the password input when queried by label.
  const passwordRevealer = (
    <Tooltip2
      content={intl.get(
        showPassword ? 'login_hide_password' : 'login_show_password',
      )}
    >
      <Button
        type={'button'}
        icon={showPassword ? 'eye-off' : 'eye-open'}
        minimal={true}
        onClick={handleLockClick}
        aria-label={
          intl.get('login_show_characters_aria') ||
          intl.get(
            showPassword ? 'login_hide_characters' : 'login_show_characters',
          )
        }
        aria-pressed={showPassword}
        data-testId={'login-password-revealer'}
      />
    </Tooltip2>
  );

  return (
    <LoginFormRoot>
      <FFormGroup
        name={'crediential'}
        label={intl.get('email_address')}
        helperText={email.helperText}
      >
        <FInputGroup
          name={'crediential'}
          large={true}
          leftIcon={'envelope'}
          autoComplete={'email'}
          inputMode={'email'}
          {...email.inputProps}
        />
      </FFormGroup>

      <FFormGroup
        name={'password'}
        label={intl.get('password')}
        helperText={password.helperText}
      >
        <FInputGroup
          name={'password'}
          large={true}
          leftIcon={'lock'}
          type={showPassword ? 'text' : 'password'}
          autoComplete={'current-password'}
          rightElement={passwordRevealer}
          {...password.inputProps}
        />
      </FFormGroup>

      <LoginFormOptions>
        <FCheckbox name={'keepLoggedIn'}>
          <T id={'keep_me_logged_in'} />
        </FCheckbox>
      </LoginFormOptions>

      <AuthSubmitButton
        type={'submit'}
        intent={Intent.PRIMARY}
        fill={true}
        large={true}
        loading={isSubmitting}
        data-testId={'login-submit'}
      >
        <T id={'log_in'} />
      </AuthSubmitButton>
    </LoginFormRoot>
  );
}

const LoginFormRoot = styled(Form)`
  .bp4-input-action .bp4-button {
    --x-color-revealer: #5f6b7a;

    .bp4-dark & {
      --x-color-revealer: rgba(255, 255, 255, 0.6);
    }
    margin: 4px 4px 0 0;
    color: var(--x-color-revealer);

    .bp4-icon {
      color: inherit;
    }
  }
`;

const LoginFormOptions = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;

  .bp4-checkbox {
    font-size: 13.5px;
    margin-bottom: 0;
  }
`;
