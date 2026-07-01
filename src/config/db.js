import mongoose from "mongoose";
import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI)
        console.log('MongoDB connected')
    } catch (error) {
      console.error('MongoDB connection failed:', error.message)
    process.exit(1)  
    }
}

export default connectDB
