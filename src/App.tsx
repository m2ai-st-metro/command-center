import { Routes, Route } from 'react-router-dom';
import { Dashboard } from './pages/Dashboard';
import { MissionDetail } from './pages/MissionDetail';
import { CustomAgents } from './pages/CustomAgents';
import { StockAgents } from './pages/StockAgents';
import { NamedAgents } from './pages/NamedAgents';
import { Schedules } from './pages/Schedules';
import { Triggers } from './pages/Triggers';
import { AITown } from './pages/AITown';
import { StMetro } from './pages/StMetro';
import { SkyLynx } from './pages/SkyLynx';
import { HiveMind } from './pages/HiveMind';
import { ScratchPad } from './pages/ScratchPad';
import { Sidebar } from './components/Sidebar';

export function App() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/mission/:id" element={<MissionDetail />} />
          <Route path="/named-agents" element={<NamedAgents />} />
          <Route path="/custom-agents" element={<CustomAgents />} />
          <Route path="/stock-agents" element={<StockAgents />} />
          <Route path="/schedules" element={<Schedules />} />
          <Route path="/triggers" element={<Triggers />} />
          <Route path="/ai-town" element={<AITown />} />
          <Route path="/st-metro" element={<StMetro />} />
          <Route path="/sky-lynx" element={<SkyLynx />} />
          <Route path="/hivemind" element={<HiveMind />} />
          <Route path="/scratchpad" element={<ScratchPad />} />
        </Routes>
      </main>
    </div>
  );
}
