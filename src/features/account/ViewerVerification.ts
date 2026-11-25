import { createContext } from 'react';

// SSR content stays mounted while hydration verifies its account. Only private
// actions and recovery storage wait for verification; public state stays intact.
export const ViewerVerification = createContext(true);
