import React, { useState, useEffect } from 'react';
import { Upload, Play, Server, Layers, BarChart3, AlertCircle } from 'lucide-react';

// Resolves the backend base URL from (in order): an explicit `apiBaseUrl` prop, a Vite
// env var, a Create React App env var, then a localhost fallback for pure local dev.
// This component ships without its own build tooling (see README) and used to hardcode
// http://localhost:5000 in three places, which meant it could never reach a Render-hosted
// backend once deployed anywhere else - pass `apiBaseUrl` explicitly when embedding this in
// a host app if neither env var convention applies.
function resolveApiBaseUrl(apiBaseUrlProp) {
  if (apiBaseUrlProp) return apiBaseUrlProp;
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  if (typeof process !== 'undefined' && process.env?.REACT_APP_API_BASE_URL) {
    return process.env.REACT_APP_API_BASE_URL;
  }
  return 'http://localhost:5000';
}

export default function CampaignManagerUI({ token, apiBaseUrl }) {
  const API_BASE_URL = resolveApiBaseUrl(apiBaseUrl);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignName, setCampaignName] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [gatewayPorts, setGatewayPorts] = useState([]);
  const [selectedPorts, setSelectedPorts] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    fetchCampaigns();
    fetchGatewayTelemetry();
    const interval = setInterval(fetchGatewayTelemetry, 10000);
    return () => clearInterval(interval);
  }, []);

  const togglePortSelection = (portNum) => {
    if (selectedPorts.includes(portNum)) {
      setSelectedPorts(selectedPorts.filter(p => p !== portNum));
    } else {
      setSelectedPorts([...selectedPorts, portNum].sort((a, b) => a - b));
    }
  };

  const fetchCampaigns = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/campaigns`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) setCampaigns(data);
    } catch (e) {
      console.error('Failed to fetch campaigns', e);
    }
  };

  const fetchGatewayTelemetry = async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/gateways/allocations`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (Array.isArray(data)) setGatewayPorts(data);
    } catch (e) {
      console.error('Failed to fetch gateway telemetry', e);
    }
  };

  const handleCreateCampaign = async (e) => {
    e.preventDefault();
    if (!campaignName || !csvFile || !audioFile) {
      alert('Please fill all fields and select files.');
      return;
    }

    setIsSubmitting(true);
    const formData = new FormData();
    formData.append('name', campaignName);
    formData.append('leadsCsv', csvFile);
    formData.append('broadcastAudio', audioFile);
    if (selectedPorts.length > 0) {
      formData.append('allowedPorts', JSON.stringify(selectedPorts));
    }

    try {
      const res = await fetch(`${API_BASE_URL}/api/campaigns/broadcast`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (res.ok) {
        alert('Campaign generated successfully. Voice files are being transcoded in the backend.');
        setCampaignName('');
        setCsvFile(null);
        setAudioFile(null);
        fetchCampaigns();
      } else {
        const errorData = await res.json();
        alert(`Error: ${errorData.error}`);
      }
    } catch (err) {
      alert(`Server error: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeSIMs = gatewayPorts.filter(p => p.status === 'REGISTER_OK').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

      {/* Dynamic Telemetry Header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
        <div className="hifi-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Server size={24} style={{ color: 'var(--accent-indigo)' }} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Connected Gateway</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold' }}>UC2000 32-Port</div>
          </div>
        </div>

        <div className="hifi-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Layers size={24} style={{ color: '#34D399' }} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Active SIM Channels</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold' }}>{activeSIMs} / {gatewayPorts.length || 32}</div>
          </div>
        </div>

        <div className="hifi-card" style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <BarChart3 size={24} style={{ color: 'var(--accent-amber)' }} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Dialer Concurrency</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold' }}>{activeSIMs} Active Workers</div>
          </div>
        </div>
      </div>

      <div className="grid-cols-2">

        {/* Create Campaign Form */}
        <div className="hifi-card">
          <h3 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={18} style={{ color: 'var(--accent-indigo)' }} /> Upload Outbound Campaign
          </h3>
          <form onSubmit={handleCreateCampaign} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Campaign Name</label>
              <input
                type="text"
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder="Broadcasting Q3 Marketing Campaign"
                className="hifi-input"
                required
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Leads list (CSV format)</label>
              <input
                type="file"
                accept=".csv"
                onChange={(e) => setCsvFile(e.target.files[0])}
                className="hifi-input"
                required
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>Broadcast Audio file (MP3/WAV)</label>
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => setAudioFile(e.target.files[0])}
                className="hifi-input"
                required
              />
            </div>

            {/* Specific Port Selection for Round-Robin */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(255, 255, 255, 0.03)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
              <label style={{ fontSize: '12px', color: 'var(--accent-indigo)', fontWeight: 600 }}>
                🔄 Select Specific SIM Ports for Round-Robin (Optional)
              </label>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                {selectedPorts.length === 0 ? 'All active ports will be used in round-robin.' : `Campaign restricted to Ports: [ ${selectedPorts.join(', ')} ]`}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                {[0, 1, 2, 3, 4, 5, 6, 7].map(portNum => {
                  const isChecked = selectedPorts.includes(portNum);
                  return (
                    <button
                      key={portNum}
                      type="button"
                      onClick={() => togglePortSelection(portNum)}
                      style={{
                        padding: '6px 8px',
                        borderRadius: '6px',
                        fontSize: '11px',
                        fontWeight: 600,
                        border: isChecked ? '1px solid var(--accent-indigo)' : '1px solid var(--border-color)',
                        background: isChecked ? 'rgba(99, 102, 241, 0.2)' : 'transparent',
                        color: isChecked ? '#fff' : 'var(--text-secondary)',
                        cursor: 'pointer'
                      }}
                    >
                      {isChecked ? '✓ ' : ''}Port {portNum}
                    </button>
                  );
                })}
              </div>
            </div>

            <button type="submit" disabled={isSubmitting} className="btn-hifi-primary" style={{ marginTop: '10px' }}>
              <Play size={14} style={{ display: 'inline', marginRight: '6px' }} />
              {isSubmitting ? 'Processing Uploads...' : 'Start Voice Campaign'}
            </button>
          </form>
        </div>

        {/* Live Campaigns Progress Board */}
        <div className="hifi-card" style={{ display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '20px' }}>Voice Campaigns Log</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto', maxHeight: '340px' }}>
            {campaigns.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '40px 0' }}>
                No automated campaigns active.
              </div>
            ) : (
              campaigns.map((camp) => {
                const percent = camp.total_leads > 0 ? Math.round((camp.processed_leads / camp.total_leads) * 100) : 0;
                return (
                  <div key={camp.id} style={{ background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-glass)', borderRadius: '12px', padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 'bold' }}>
                      <span>{camp.name}</span>
                      <span style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        background: camp.status === 'running' ? 'rgba(99,102,241,0.1)' : 'rgba(52,211,153,0.1)',
                        color: camp.status === 'running' ? 'var(--accent-indigo)' : '#34D399'
                      }}>{camp.status}</span>
                    </div>

                    {/* Progress Bar */}
                    <div style={{ width: '100%', background: '#090D16', height: '6px', borderRadius: '4px', margin: '12px 0 6px 0', overflow: 'hidden' }}>
                      <div style={{ width: `${percent}%`, background: 'var(--accent-indigo)', height: '100%' }} />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                      <span>Progress: {percent}%</span>
                      <span>{camp.processed_leads} / {camp.total_leads} Leads Dialed</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
