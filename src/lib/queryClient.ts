import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** Shared so non-React code (the tabletop sync engine) can invalidate queries on realtime events. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && [401, 403, 404].includes(err.status)) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});
