import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom';
import { Driver } from './pages/Driver';
import { Kitchen } from './pages/Kitchen';
import { Ops } from './pages/Ops';
import { Order } from './pages/Order';
import { Shop } from './pages/Shop';
import './styles.css';

function App() {
  return (
    <BrowserRouter>
      <nav className="topbar">
        <Link to="/" className="brand">
          <span aria-hidden="true">🍕</span> Kultainen Näyte
        </Link>
        <div className="staff-links">
          <NavLink to="/kitchen">Keittiö</NavLink>
          <NavLink to="/driver">Kuljettaja</NavLink>
          <NavLink to="/ops">Tilannekuva</NavLink>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<Shop />} />
        <Route path="/order/:id" element={<Order />} />
        <Route path="/kitchen" element={<Kitchen />} />
        <Route path="/driver" element={<Driver />} />
        <Route path="/ops" element={<Ops />} />
        <Route
          path="*"
          element={
            <main className="page narrow">
              <h1>Sivua ei löytynyt</h1>
              <Link to="/">Takaisin ruokalistalle</Link>
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
