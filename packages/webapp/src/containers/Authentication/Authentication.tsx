import { Spinner } from '@blueprintjs/core';
import { Suspense } from 'react';
import BodyClassName from 'react-body-classname';
import { Route, Switch, useLocation } from 'react-router-dom';
import { TransitionGroup, CSSTransition } from 'react-transition-group';
import styled from 'styled-components';
import { AuthMetaBootProvider } from './AuthMetaBoot';
import { Box, Icon } from '@/components';
import { BigcapitalAlt } from '@/components/Icons/BigcapitalAlt';
import { useIsDarkMode } from '@/hooks/useDarkMode';
import authenticationRoutes from '@/routes/authentication';

import '@/style/pages/Authentication/Auth.scss';

export function Authentication() {
  const isDarkMode = useIsDarkMode();

  return (
    <BodyClassName className={'authentication'}>
      <AuthPage>
        <AuthInsider>
          <AuthLogo>
            {isDarkMode ? (
              <BigcapitalAlt
                color={'rgba(255, 255, 255, 0.6)'}
                height={37}
                width={214}
              />
            ) : (
              <Icon icon="bigcapital" height={37} width={214} />
            )}
          </AuthLogo>

          <AuthMetaBootProvider>
            <Suspense
              fallback={
                <Box style={{ marginTop: '5rem' }}>
                  <Spinner size={30} />
                </Box>
              }
            >
              <AuthenticationRoutes />
            </Suspense>
          </AuthMetaBootProvider>
        </AuthInsider>
      </AuthPage>
    </BodyClassName>
  );
}

function AuthenticationRoutes() {
  const location = useLocation();
  const locationKey = location.pathname;

  return (
    <TransitionGroup>
      <CSSTransition
        timeout={500}
        key={locationKey}
        classNames="authTransition"
      >
        <Switch>
          {authenticationRoutes.map((route, index) => (
            <Route key={index} path={route.path} component={route.component} />
          ))}
        </Switch>
      </CSSTransition>
    </TransitionGroup>
  );
}

const AuthPage = styled.div`
  --x-auth-background: linear-gradient(180deg, #fafbfc 0%, #eef1f6 100%);

  .bp4-dark & {
    --x-auth-background: radial-gradient(
        120% 75% at 50% 0%,
        rgba(138, 187, 255, 0.09) 0%,
        rgba(138, 187, 255, 0) 62%
      ),
      var(--color-dark-gray1);
  }
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 56px 20px;
  background: var(--x-auth-background);

  @media (max-width: 480px) {
    justify-content: flex-start;
    padding: 36px 16px 28px;
  }
`;

// Fluid width so narrow phones never overflow horizontally.
const AuthInsider = styled.div`
  width: min(420px, 100%);
  margin: 0 auto;
`;

const AuthLogo = styled.div`
  text-align: center;
  margin-bottom: 30px;

  svg {
    max-width: 100%;
    height: auto;
  }
`;
