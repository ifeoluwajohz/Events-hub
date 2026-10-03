const { PrismaClient } = require("@prisma/client");
const admin = require("../configs/firebaseAdmin");
const jwt = require("jsonwebtoken"); // For generating the token

const prisma = new PrismaClient();

const maxage = 3 * 24 * 60 * 60;
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// user profile controllers
const getUserDetails = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }
    res.status(201).json({ user });
  } catch (err) {
    console.log(err.message);
    res.status(500).json({ err: err.message });
  }
};

const loginUser = async (req, res) => {
  const { idToken } = req.body;

  try {
    if (!idToken) {
      console.log("token not found");
      return res.status(400).json({ error: "ID token is required" });
    }

    // Verify the ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, name, email, picture } = decodedToken;

    // Check if the user exists in the database
    let user = await prisma.user.findUnique({ where: { firebaseUid: uid } });

    if (user) {
      // Generate JWT for existing user
      const token = generateToken(user.id);

      // res.cookie('jwt', token, {httpOnly: true, maxAge: maxage * 1000, secure: true, sameSite: 'lax'})
      return res
        .status(201)
        .json({ message: "Welcome, new user!", user, token });
    }

    // Create a new user with necessary related data
    const now = new Date();
    user = await prisma.user.create({
      data: {
        firebaseUid: uid,
        name: name || "Anonymous",
        email: email || null,
        profilePicture: picture || null,
        role: "USER",
        bookings: {},
        tickets: {},
        reviews: {},
        admin: {
          create: {
            createdAt: now,
            updatedAt: now,
          },
        },
      },
    });

    // Generate JWT for the new user
    const token = generateToken(user.id);

    // Respond with user details and token
    //   res.cookie('jwt', token, {httpOnly: true, maxAge: maxage * 1000, secure: true, sameSite: 'lax'})
    return res.status(201).json({ message: "Welcome, new user!", user, token });
  } catch (err) {
    console.error("Error verifying ID token:", err.message);
    res.status(400).json({ error: err.message });
  }
};

const updateUser = async (req, res) => {
  const { id } = req.params; // Extract the user ID from the route parameter
  const userData = req.body; // Extract user data from the request body

  try {
    // Check if the user exists
    const existingUser = await prisma.user.findUnique({
      where: { id: id },
    });

    if (!existingUser) {
      return res.status(404).json({ error: `User with ID ${id} not found` });
    }

    // Update the user with new data
    const updatedUser = await prisma.user.update({
      where: { id: id },
      data: { userData }, // Spread operator to dynamically update fields
    });

    return res.status(200).json({
      message: `User ID ${id} updated successfully`,
      data: updatedUser,
    });
  } catch (err) {
    console.log("Error updating user:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const switchRole = async (req, res) => {
  const { id, currentRole } = req.body;

  if (!id || !currentRole) {
    return res
      .status(400)
      .json({ error: "User ID and current role are required" });
  }

  const validRoles = ["USER", "ADMIN"];
  if (!validRoles.includes(currentRole)) {
    return res.status(400).json({ error: "Invalid role provided" });
  }

  try {
    // Fetch the user
    const user = await prisma.user.findUnique({
      where: { id },
      include: { admin: true }, // Include Admin relation
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    let newRole = currentRole === "USER" ? "ADMIN" : "USER";

    if (newRole === "ADMIN") {
      if (!user.admin) {
        // Create an admin record if it doesn't exist
        await prisma.admin.create({
          data: { userId: id },
        });
      } else {
      }
    } else if (newRole === "USER") {
      if (user.admin) {
        // Optional: Remove admin privileges or handle deactivation
        console.log("Switching to USER: Admin privileges will be deactivated");
        // Example: Remove admin record (if you want to delete it)
        // await prisma.admin.delete({
        //     where: { userId: id },
        // });
      }
    }

    // Update the user's role
    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role: newRole },
    });

    return res.status(200).json({
      message: `User role switched to ${newRole}`,
      data: updatedUser,
    });
  } catch (err) {
    console.error("Error switching role:", err.message);
    return res
      .status(500)
      .json({ error: "An error occurred while switching roles" });
  }
};

// user tickets controllers
const getUserTicket = async (req, res) => {
  const { id } = req.params;
  // Logic to fetch tickets purchased by the user
  try {
    const userData = req.body;
    // Logic to update user details in the database
    res.status(201).json({ message: `Tickets for user ID: ${id}` });
  } catch (err) {
    console.log(err.message);
  }
};

const getAllTicket = async (req, res) => {
  try {
    req.status(201).json({ message: "All tickets" });
  } catch (err) {
    console.log(err.message);
  }
};

const deleteTicket = async (req, res) => {
  const { id } = req.params;

  try {
    req.staus(201).json({ message: `deleted post ${id}` });
  } catch (err) {
    console.log(err.message);
  }
};

module.exports = {
  getUserDetails,
  switchRole,
  loginUser,
  updateUser,
  getUserTicket,
  getAllTicket,
  deleteTicket,
};
