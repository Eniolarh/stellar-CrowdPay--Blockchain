import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];

const ADMIN_TABS = [
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'disputes', label: 'Dispute Queue' },
];

function DisputeQueue() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    // Load open/under_review disputes across all campaigns via admin endpoint
    api.getAdminCampaigns()
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api.getCampaignDisputes(c.id)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, []);

  async function resolve(dispute, status) {
    const note = window.prompt(`Resolution note (${status}):`, '');
    if (note === null) return;
    setBusyId(dispute.id);
    try {
      const updated = await api.updateDispute(dispute.id, { status, resolution_note: note || undefined });
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      alert(err.message || 'Could not update dispute');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;
  if (!disputes.length) return <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No disputes on record.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div
          key={d.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{d.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{d.id}
              </span>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'var(--color-accent-soft)',
                color: 'var(--color-accent)',
              }}
            >
              {d.status}
            </span>
          </div>

          <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>{d.reason}</p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            {DISPUTE_STATUSES.filter((s) => s !== d.status).map((s) => (
              <button
                key={s}
                disabled={busyId === d.id}
                onClick={() => resolve(d, s)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary)',
                  cursor: 'pointer',
                  opacity: busyId === d.id ? 0.5 : 1,
                }}
              >
                → {s}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  function load() {
    api.getAdminCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }

  async function feature(id) {
    const note = window.prompt('Featured note (optional):', '');
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      load();
    } catch (err) {
      alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!window.confirm('Remove from featured?')) return;
    try {
      await api.adminUnfeatureCampaign(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading campaigns…</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {campaigns.map((c) => (
        <div
          key={c.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{c.title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{c.id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => feature(c.id)}
                style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.7rem', borderRadius: '6px',
                  border: '1px solid #fde047', background: '#fef9c3', color: '#854d0e', cursor: 'pointer'
                }}
              >
                ⭐️ Feature
              </button>
              <button
                onClick={() => unfeature(c.id)}
                style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.7rem', borderRadius: '6px',
                  border: '1px solid var(--color-border-light)', background: 'var(--color-bg-secondary)', cursor: 'pointer'
                }}
              >
                Unfeature
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('campaigns');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  function handleTablistKeyDown(e) {
    const currentIndex = ADMIN_TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % ADMIN_TABS.length;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = ADMIN_TABS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    setActiveTab(ADMIN_TABS[nextIndex].id);
    document.getElementById(`tab-${ADMIN_TABS[nextIndex].id}`)?.focus();
  }

  return (
    <div style={{ maxWidth: '860px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      <div
        role="tablist"
        aria-label="Admin sections"
        onKeyDown={handleTablistKeyDown}
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: '0.5rem',
        }}
      >
        {ADMIN_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: activeTab === tab.id ? 'var(--color-accent)' : 'transparent',
              color: activeTab === tab.id ? '#fff' : 'var(--color-text-secondary)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'campaigns' && (
        <section
          id="panel-campaigns"
          role="tabpanel"
          aria-labelledby="tab-campaigns"
          tabIndex={0}
        >
          <CampaignsQueue />
        </section>
      )}

      {activeTab === 'disputes' && (
        <section
          id="panel-disputes"
          role="tabpanel"
          aria-labelledby="tab-disputes"
          tabIndex={0}
        >
          <DisputeQueue />
        </section>
      )}
    </div>
  );
}