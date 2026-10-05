// import { useState } from "react"
import { Route, Routes } from "react-router-dom";

import Home from "./pages/Home";
import Faq from "./components/FAQ";
import Navbar from "./components/Navbar";

import ProfilePage from "./utils/ProfilePage";
import AccountPage from "./utils/AccountPage";

import ExtraInfo from "./components/ExtraInfo";
import RoleSelectionPage from "./components/RoleSelectionPage";
import AdminQuestionsPage from "./components/AdminQuestionPage";
import AttendeeQuestionsPage from "./components/AttendeeQuestionsPage";
import SummaryPage from "./components/SummaryPage";

import EventsPage from "./components/EventsPage";
import Events from "./pages/Events";
import TicketPage from "./pages/TicketPage";
import TicketManagement from "./pages/TicketManagement";

import EventDeatils from "./components/EventDetails";
import Footer from "./components/Footer";

const App = () => {
  return (
    <>
      <Navbar />

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/Faq" element={<Faq />} />
      </Routes>

      <Routes>
        <Route path="/accountconfig" element={<AccountPage />} />
        <Route path="/profile" element={<ProfilePage />} />
      </Routes>

      <Routes>
        <Route path="/EventsPage/:location" element={<EventsPage />} />

        <Route path="/event/:id" element={<EventDeatils />} />
        <Route path="/events" element={<Events />} />
        <Route path="/ticket/:id" element={<TicketPage />} />
        <Route path="/tickets" element={<TicketManagement />} />
      </Routes>

      <Routes>
        <Route path="/extra_info" element={<ExtraInfo />} />
        <Route path="/questions" element={<RoleSelectionPage />} />
        <Route path="/createEvent" element={<AdminQuestionsPage />} />
        <Route path="/attendee-questions" element={<AttendeeQuestionsPage />} />
        <Route path="/summary" element={<SummaryPage />} />
      </Routes>
      <Footer />
    </>
  );
};

export default App;
