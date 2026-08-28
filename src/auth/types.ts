export type TwoFactorMethod = 'OTP' | 'PUSH' | 'NUMBER_MATCH';

export interface LoginSuccessResult {
  status: 'SUCCESS';
  cookies: string;
  storageState?: unknown;
  expiresAt?: Date | null;
  rawSession?: Record<string, unknown>;
}

export interface LoginRequires2FaResult {
  status: 'REQUIRES_2FA';
  method: TwoFactorMethod;
  message: string;
  challengeContext: unknown;
}

export interface LoginFailedResult {
  status: 'FAILED';
  error: string;
}

export type LoginResult = LoginSuccessResult | LoginRequires2FaResult | LoginFailedResult;

export interface AuibAuthenticator {
  /**
   * Begins the authentication handshake with AUIB SIS / Identity Provider using student email and password.
   */
  startLogin(email: string, password: string): Promise<LoginResult>;

  /**
   * Submits 2FA code or confirmation for an active challenge context.
   */
  submit2Fa(challengeContext: unknown, code: string): Promise<LoginResult>;

  /**
   * Performs silent background session refresh using saved browser storage state (KMSI cookies).
   */
  refreshSession?(storageState: unknown): Promise<LoginSuccessResult | null>;
}

export type LoginWizardStep = 'AWAITING_EMAIL' | 'AWAITING_PASSWORD' | 'AWAITING_2FA';

export interface UserLoginState {
  step: LoginWizardStep;
  email?: string;
  challengeContext?: unknown;
  startedAt: number;
}
