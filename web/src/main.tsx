import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { Chat } from './pages/Chat';
import { Driver } from './pages/Driver';
import { Kitchen } from './pages/Kitchen';
import { Ops } from './pages/Ops';
import { Order } from './pages/Order';
import { Proposal } from './pages/Proposal';
import { Shop } from './pages/Shop';
import './styles.css';

function App() {
  return (
    <BrowserRouter>
      <nav className="topbar">
        <Link to="/" className="brand">
          <span aria-hidden="true">🍕</span> Golden Sample
        </Link>
        <div className="staff-links">
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/kitchen">Kitchen</NavLink>
          <NavLink to="/driver">Driver</NavLink>
          <NavLink to="/ops">Overview</NavLink>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<Shop />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/proposal/:id" element={<Proposal />} />
        <Route path="/order/:id" element={<Order />} />
        <Route path="/kitchen" element={<Kitchen />} />
        <Route path="/driver" element={<Driver />} />
        <Route path="/ops" element={<Ops />} />
        <Route
          path="*"
          element={
            <main className="page narrow">
              <h1>Page not found</h1>
              <Link to="/">Back to the menu</Link>
            </main>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
