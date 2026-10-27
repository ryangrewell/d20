import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { Toaster } from 'sonner';
import { Spinner } from '@/components/ui/primitives';
import { AuthProvider, RequireAuth } from './auth';
import { AppLayout } from '@/components/layout/AppLayout';
import { HomePage } from '@/features/home/HomePage';
import { SignInPage, SignUpPage, VerifyPage, ForgotPasswordPage } from '@/features/auth/AuthPages';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { InvitePage } from '@/features/invites/InvitePage';
import { CampaignPage } from '@/features/campaigns/CampaignPage';
import { AccountPage } from '@/features/auth/AccountPage';
import { LegalPage } from '@/features/home/LegalPage';

// The tabletop and map tooling pull in PixiJS; load them on demand.
const TabletopPage = lazy(() => import('@/features/tabletop/TabletopPage'));
const MapSetupPage = lazy(() => import('@/features/maps/MapSetupPage'));
const CharacterPage = lazy(() => import('@/features/characters/CharacterPage'));


const fallback = (
  <div className="grid h-full place-items-center">
    <Spinner />
  </div>
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={fallback}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/sign-in" element={<SignInPage />} />
              <Route path="/sign-up" element={<SignUpPage />} />
              <Route path="/verify" element={<VerifyPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/legal" element={<LegalPage />} />
              <Route path="/invite/:token" element={<RequireAuth><InvitePage /></RequireAuth>} />
              <Route path="/campaigns/:campaignId/sessions/:sessionId" element={<RequireAuth><TabletopPage /></RequireAuth>} />
              <Route path="/campaigns/:campaignId/sessions/:sessionId/display" element={<RequireAuth><TabletopPage display /></RequireAuth>} />
              <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/campaigns/:campaignId" element={<CampaignPage />} />
                <Route path="/campaigns/:campaignId/maps/:mapId" element={<MapSetupPage />} />
                <Route path="/campaigns/:campaignId/characters/:characterId" element={<CharacterPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster theme="dark" position="bottom-right" richColors closeButton />
      </AuthProvider>
    </QueryClientProvider>
  );
}
