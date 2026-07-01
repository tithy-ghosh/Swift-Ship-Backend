import mongoose from 'mongoose'

const userSchema = new mongoose.Schema(
  {
    uid: {
      type: String,
      required: true,
      unique: true, // Firebase UID
    },
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    phone: {
      type: String,
      default: '',
    },
    role: {
      type: String,
      enum: ['customer', 'rider', 'admin'],
      default: 'customer',
    },
  },
  { timestamps: true }
)

const User = mongoose.model('User', userSchema)

export default User