import React, { useState } from "react";
import { motion } from "framer-motion";
import { FaCamera } from "react-icons/fa";
import { useUser } from "@clerk/clerk-react";

const ProfilePage: React.FC = () => {
  // const { userProfile, updateUserProfile, user } = useAuth();
  const {user} = useUser();
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState({
    // preferredName: userProfile?.prefferedName || "Your Name",
    // handle: userProfile?.handle || "@username",
    // bio: userProfile?.bio || "Add a short bio...",
    // location: userProfile?.location || "Location",
    // profilePicture: userProfile?.profilePicture || "/default-avatar.png",
    // coverPhoto: userProfile?.coverPhoto || "/default-cover.jpg",
    // email: userProfile?.email || "Email",
  });

  if (!user) {
    return (
      <div className="flex justify-center items-center h-screen bg-gray-100">
        <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-blue-500"></div>
      </div>
    );
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Cover Photo (Jumbotron Style) */}
      <div className="relative w-full h-[40vh]">
        <img
          // src={formData.coverPhoto}
          alt="Cover"
          className="w-full h-full object-cover brightness-75"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-gray-900 to-transparent"></div>
        {user?.id  && (
          <button
            onClick={() => setEditMode(!editMode)}
            className="absolute right-4 top-4 underline text-white p-2 rounded-full shadow-md hover:text-blue-400 focus:outline-none"
          >
            {/* <p>Edit Profile</p> */}
            <FaCamera />
          </button>
        )}
        {editMode && (
          <div className="absolute right-4 bottom-4 bg-gray-900 bg-opacity-75 text-white p-2 rounded-md">
            <input
              type="file"
              name="coverPhoto"
              onChange={(e) =>
                setFormData({
                  ...formData,
                  coverPhoto: URL.createObjectURL(e.target.files![0]),
                })
              }
              className="file-input"
            />
          </div>
        )}
      </div>

      {/* Profile Card */}
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="max-w-2xl mx-auto -mt-24 bg-white shadow-xl rounded-lg p-6 relative text-gray-900 backdrop-blur-md bg-opacity-90"
      >
        <div className="relative">
          {/* Profile Picture */}
          <motion.img
            // src={formData.profilePicture}
            alt="Profile"
            className="w-32 h-32 rounded-full border-4 shadow-lg mx-auto"
            whileHover={{ scale: 1.05 }}
          />
          {editMode && (
            <div className="absolute right-4 bottom-4 bg-gray-900 bg-opacity-75 text-white p-2 rounded-md">
              <input
                type="file"
                name="profilePicture"
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    profilePicture: URL.createObjectURL(e.target.files![0]),
                  })
                }
                className="file-input"
              />
            </div>
          )}
        </div>

        {/* Profile Details */}
        <div className="text-center mt-4">
          {editMode ? (
            <>
              <input
                type="text"
                name="preferredName"
                // value={formData.preferredName}
                onChange={handleInputChange}
                className="text-3xl font-bold text-gray-900 border-b-2 border-gray-300 focus:outline-none mb-2 w-full text-center"
              />
              <input
                type="text"
                name="handle"
                // value={formData.handle}
                onChange={handleInputChange}
                className="text-lg text-gray-500 mb-2 w-full text-center"
              />
              <textarea
                name="bio"
                // value={formData.bio}
                onChange={handleInputChange}
                className="w-full text-gray-700 mt-4 border-b-2 border-gray-300 p-2 resize-none"
                rows={3}
              />
              <input
                type="text"
                name="location"
                // value={formData.location}
                onChange={handleInputChange}
                className="w-full text-gray-500 mt-2 border-b-2 border-gray-300 p-2"
                // disabled={user?.uid !== userProfile.id}
              />
              <input
                type="email"
                name="email"
                // value={formData.email}
                onChange={handleInputChange}
                className="w-full text-gray-500 mt-2 border-b-2 border-gray-300 p-2"
                disabled={true}
              />
            </>
          ) : (
            <>
              {/* <h2 className="text-3xl font-bold">{formData.preferredName}</h2> */}
              {/* <p className="text-gray-500">{formData.handle}</p>
              <p className="text-gray-700 mt-2">{formData.bio}</p>
              <p className="text-gray-600 mt-1">{formData.location}</p>
              <p className="text-gray-400 mt-1">{formData.email}</p> */}
            </>
          )}
        </div>

        {/* Save or Edit Button */}
        <div className="flex justify-center mt-4">
          {/* {user?.uid === userProfile.id && (
            <button
              onClick={editMode ? handleSave : () => setEditMode(true)}
              className={`${
                editMode ? "bg-green-500 hover:bg-green-400" : "bg-blue-500 hover:bg-blue-400"
              } text-white px-5 py-2 rounded-md font-semibold transition transform hover:scale-105`}
            >
              {editMode ? <FaSave /> : <FaEdit />}
            </button>
          )} */}
        </div>
      </motion.div>

      {/* Stats Section */}
      <div className="max-w-2xl mx-auto mt-6 p-6 bg-gray-800 rounded-lg shadow-md flex justify-between">
        <div className="text-center">
          <p className="text-lg font-bold text-white">320</p>
          <p className="text-gray-400 text-sm">Posts</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-white">1.5K</p>
          <p className="text-gray-400 text-sm">Followers</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-white">200</p>
          <p className="text-gray-400 text-sm">Following</p>
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
