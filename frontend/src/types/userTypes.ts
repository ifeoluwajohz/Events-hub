export interface UserProfile {
  id: string;
  bio: string;
  handle: string;
  email: string;
  firebaseUid: string | null;
  name: string;
  role: Role | string;
  location: string | null;
  prefferedName: string | null;
  coverPhoto: string | null;
  profilePicture: string | null;
  event?: Event | null;
}

export interface Role {
  role: string;
}

interface Event{
  title: string;
  shortDescription: string;
  longDescription: string;
  date: Date;
  venue: string;
  capacity: number;
  avalaibleTickets: number
  eventType: ["PAID", "FREE"];
  price: number;
}