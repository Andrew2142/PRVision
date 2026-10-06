import { createContext, type ReactElement, type ReactNode } from "react";

const AUTH_STATE = {
  user: { id: "usr_17", name: "Priya Raman", email: "priya.raman@example.com", roles: ["admin"] },
  isAuthenticated: true,
  isLoading: false,
  hasPermission: (_permission: string): boolean => true,
  login: async (): Promise<void> => undefined,
  logout: async (): Promise<void> => undefined,
};

export const AuthContext = createContext(AUTH_STATE);

export function useAuth(): typeof AUTH_STATE {
  return AUTH_STATE;
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  return <AuthContext.Provider value={AUTH_STATE}>{children}</AuthContext.Provider>;
}
