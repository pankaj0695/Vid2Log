"use client";

import { useEffect, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { AdminStats, UserProfile } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Spinner } from "@/components/ui/Spinner";
import { Tabs } from "@/components/ui/Tabs";
import { DonutChart } from "@/components/ui/charts";

type Tab = "overview" | "users";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function AdminContent() {
  const { firebaseUser } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<UserProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  const [cleanupResult, setCleanupResult] = useState<{ found: number; deleted: number } | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  async function load() {
    setError(null);
    try {
      const [s, u] = await Promise.all([api.admin.stats(), api.admin.listUsers()]);
      setStats(s);
      setUsers(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load admin data.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function toggleRole(user: UserProfile) {
    setBusyUid(user.uid);
    try {
      const newRole = user.role === "admin" ? "user" : "admin";
      await api.admin.updateUserRole(user.uid, newRole);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role.");
    } finally {
      setBusyUid(null);
    }
  }

  async function handleCleanup() {
    setCleanupBusy(true);
    setError(null);
    try {
      const result = await api.admin.cleanupStaleVideos();
      setCleanupResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed.");
    } finally {
      setCleanupBusy(false);
    }
  }

  return (
    <AppShell section="admin" crumb="Admin">
      <Container className="py-10">
        <PageHeader
          eyebrow="Admin"
          title="Admin dashboard"
          description="System-wide visibility across users, jobs, and models. Only visible to accounts with role=admin."
        />

        <Tabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "users", label: "Users" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {error && <Alert tone="danger" className="mb-6">{error}</Alert>}

        {tab === "overview" ? (
          <>
            {stats === null ? (
              <Spinner label="Loading system stats..." />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <StatCard label="Users" value={stats.total_users} hint={`${stats.total_admins} admin(s)`} />
                  <StatCard label="Video jobs" value={stats.total_jobs} />
                  <StatCard label="Models" value={stats.total_models} hint={stats.active_model_id ? "1 active" : "none active"} />
                  <StatCard label="Training jobs" value={stats.total_training_jobs} />
                </div>

                <div className="mt-10 grid gap-6 lg:grid-cols-3">
                  <Card className="lg:col-span-2">
                    <CardHeader title="Video jobs by status" />
                    {Object.keys(stats.jobs_by_status).length > 0 ? (
                      <DonutChart
                        data={Object.entries(stats.jobs_by_status).map(([label, value]) => ({ label, value }))}
                      />
                    ) : (
                      <p className="text-sm text-neutral-500">No jobs yet.</p>
                    )}
                  </Card>

                  <Card>
                    <CardHeader
                      title="Storage cleanup"
                      description="Reclaims Cloud Storage videos that survived past their normal processing lifecycle (e.g. a crashed worker)."
                    />
                    <Button variant="outline" className="w-full" onClick={handleCleanup} loading={cleanupBusy}>
                      Run stale-video cleanup
                    </Button>
                    {cleanupResult && (
                      <p className="mt-3 text-sm text-neutral-600">
                        Found {cleanupResult.found}, deleted {cleanupResult.deleted}.
                      </p>
                    )}
                  </Card>
                </div>
              </>
            )}
          </>
        ) : (
          <Card>
            <CardHeader title="Users" description="Promote or demote accounts between user and admin." />
            {users === null ? (
              <Spinner label="Loading users..." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-neutral-500">
                    <tr>
                      <th className="px-2 py-2 font-medium">Name</th>
                      <th className="px-2 py-2 font-medium">Email</th>
                      <th className="px-2 py-2 font-medium">Role</th>
                      <th className="px-2 py-2 font-medium">Joined</th>
                      <th className="px-2 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {users.map((u) => (
                      <tr key={u.uid}>
                        <td className="px-2 py-2 text-text">{u.display_name || "—"}</td>
                        <td className="px-2 py-2 text-neutral-600">{u.email}</td>
                        <td className="px-2 py-2">
                          <Badge tone={u.role === "admin" ? "secondary" : "neutral"}>{u.role}</Badge>
                        </td>
                        <td className="px-2 py-2 text-neutral-500">{formatDate(u.created_at)}</td>
                        <td className="px-2 py-2 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => toggleRole(u)}
                            loading={busyUid === u.uid}
                            disabled={u.uid === firebaseUser?.uid}
                          >
                            {u.role === "admin" ? "Demote" : "Promote"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </Container>
    </AppShell>
  );
}

export default function AdminPage() {
  return (
    <ProtectedRoute adminOnly>
      <AdminContent />
    </ProtectedRoute>
  );
}
