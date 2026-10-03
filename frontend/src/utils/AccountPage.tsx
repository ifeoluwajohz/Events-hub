import React from "react";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignOutButton,
  useUser
} from "@clerk/clerk-react";
import { Link } from "react-router-dom";

// Profile editing (preferred name, location) and role switching used to come
// from a Firebase-era AuthContext that no longer exists. They need the
// backend's Clerk migration and are tracked in docs/SECURITY.md (Phase 2).
const AccountPage: React.FC = () => {
  const { user } = useUser();

  return (
    <div className="w-full px-5 md:px-12 mt-10">
      <SignedOut>
        <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4">
          <p>Please sign in to manage your account.</p>
          <SignInButton>
            <button className="mt-4 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
              Sign In
            </button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        <h1 className="text-2xl font-bold text-gray-800 mb-6">
          Welcome {user?.fullName || ""}!
        </h1>
        <div className="space-y-8">
          <div>
            <p className="text-gray-700">
              You are signed in as{" "}
              <strong>{user?.primaryEmailAddress?.emailAddress}</strong>.
            </p>

            <p className="my-4">
              <Link
                to="/profile"
                className="mt-4 text-blue-600 hover:text-blue-700 cursor-pointer"
              >
                View Your Profile
              </Link>
            </p>

            <p className="mt-4">
              <Link
                to="/tickets"
                className="text-blue-600 hover:text-blue-700 cursor-pointer"
              >
                Manage Events
              </Link>
            </p>
          </div>
          <SignOutButton>Log out</SignOutButton>
        </div>
      </SignedIn>
    </div>
  );
};

export default AccountPage;
