/**
 * Shared per-page frame for the authentication pages.
 *
 * `AuthInsider` is a layout component, not a routed page: it wraps whatever a
 * page renders in `AuthInsiderContent` and appends the optional
 * `AuthCopyright` footer. It is consumed by `Login`, `RegisterUserForm`,
 * `ResetPassword`, `SendResetPassword`, `InviteAccept` and `RegisterVerify`,
 * all of which are mounted by `@/routes/authentication` inside the
 * `Authentication.tsx` shell — the shell contributes the page background,
 * logo, `AuthMetaBootProvider` and route transitions, so this component only
 * owns the inner column and copyright.
 *
 * Note: `Authentication.tsx` also declares an unrelated local styled `div`
 * named `AuthInsider`; the two are distinct.
 */
import { ReactNode } from 'react';
import styled from 'styled-components';
import { AuthInsiderContent, AuthInsiderCopyright } from './_components';
import { AuthCopyright } from './AuthCopyright';

export interface AuthInsiderProps {
  logo?: boolean;
  copyright?: boolean;
  children?: ReactNode;
  classNames?: {
    content?: string;
    copyrightWrap?: string;
  };
}

/**
 * Authentication insider layout frame.
 */
export function AuthInsider({
  logo = true,
  copyright = true,
  children,
  classNames,
}: AuthInsiderProps) {
  return (
    <AuthInsiderContent>
      <AuthInsiderContentWrap className={classNames?.content}>
        {children}
      </AuthInsiderContentWrap>

      {copyright && (
        <AuthInsiderCopyright className={classNames?.copyrightWrap}>
          <AuthCopyright />
        </AuthInsiderCopyright>
      )}
    </AuthInsiderContent>
  );
}

const AuthInsiderContentWrap = styled.div``;
