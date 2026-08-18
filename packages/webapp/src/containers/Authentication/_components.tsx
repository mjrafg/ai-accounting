import { Spinner } from '@blueprintjs/core';
import { Button } from '@blueprintjs/core';
import styled from 'styled-components';

export function AuthenticationLoadingOverlay() {
  return (
    <AuthOverlayRoot>
      <Spinner size={50} />
    </AuthOverlayRoot>
  );
}

const AuthOverlayRoot = styled.div`
  --x-color-background: rgba(252, 253, 255, 0.5);

  .bp4-dark & {
    --x-color-background: rgba(37, 42, 49, 0.6);
  }
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  right: 0;
  background: var(--x-color-background);
  display: flex;
  justify-content: center;
`;

export const AuthInsiderContent = styled.div`
  position: relative;
`;
export const AuthInsiderCard = styled.div<{ textAlign?: string }>`
  --x-color-background: #fff;
  --x-color-border: #e2e6ea;
  --x-color-shadow-ambient: rgba(16, 24, 40, 0.06);
  --x-color-shadow-key: rgba(16, 24, 40, 0.14);
  --x-color-label: #3b444f;

  .bp4-dark & {
    --x-color-background: var(--color-dark-gray2);
    --x-color-border: rgba(255, 255, 255, 0.09);
    --x-color-shadow-ambient: rgba(0, 0, 0, 0.24);
    --x-color-shadow-key: rgba(0, 0, 0, 0.4);
    --x-color-label: rgba(255, 255, 255, 0.85);
  }
  border: 1px solid var(--x-color-border);
  box-shadow:
    0 1px 2px var(--x-color-shadow-ambient),
    0 18px 42px -22px var(--x-color-shadow-key);
  padding: 32px 30px;
  background: var(--x-color-background);
  border-radius: 10px;
  text-align: ${({ textAlign }) => textAlign || 'inherit'};

  .bp4-form-group {
    margin-bottom: 18px;

    label.bp4-label {
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--x-color-label);
    }
  }

  .bp4-input {
    border-radius: 6px;
  }

  @media (max-width: 480px) {
    padding: 24px 20px;
    border-radius: 8px;
  }
`;

export const AuthInsiderCopyright = styled.div`
  text-align: center;
  font-size: 12px;
  color: #666;
  margin-top: 1.75rem;
  opacity: 0.75;

  .bp4-icon-bigcapital {
    svg {
      path {
        fill: #a3a3a3;
      }
    }
  }
`;

export const AuthFooterLinks = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-left: 1.2rem;
  padding-right: 1.2rem;
  margin-top: 1.5rem;
  text-align: center;
`;

export const AuthFooterLink = styled.p`
  --x-color-text: #5f6b7a;

  .bp4-dark & {
    --x-color-text: rgba(255, 255, 255, 0.7);
  }
  color: var(--x-color-text);
  font-size: 13.5px;
  margin: 0;

  a {
    font-weight: 500;

    &:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
      border-radius: 2px;
    }
  }
`;

export const AuthSubmitButton = styled(Button)`
  margin-top: 20px;

  &.bp4-button {
    height: 44px;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 600;
  }
`;

/**
 * Heading block of the authentication card (title + supporting sentence).
 */
export const AuthCardHeading = styled.div`
  margin-bottom: 26px;
`;

export const AuthCardTitle = styled.h1`
  --x-color-text: #11181c;

  .bp4-dark & {
    --x-color-text: #fff;
  }
  color: var(--x-color-text);
  font-size: 22px;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 6px;
`;

export const AuthCardSubtitle = styled.p`
  --x-color-text: #5f6b7a;

  .bp4-dark & {
    --x-color-text: rgba(255, 255, 255, 0.65);
  }
  color: var(--x-color-text);
  font-size: 13.5px;
  line-height: 1.5;
  margin: 0;
`;
