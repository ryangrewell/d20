import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api/client';

/** Live admin check from the server (not the possibly stale token claim). */
export const useIsAdmin = () =>
  useQuery({ queryKey: ['me', 'admin'], queryFn: async () => (await api<{ isPlatformAdmin: boolean }>('/me/admin')).isPlatformAdmin, staleTime: 60_000 });
