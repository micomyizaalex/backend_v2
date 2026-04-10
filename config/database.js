require("dotenv").config();
const { Sequelize } = require("sequelize");

if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Create a backend/.env with DATABASE_URL or set the env var.');
}

// Allow disabling SSL for local dev via DB_SSL=false
const useDbSsl = process.env.DB_SSL !== 'false';

const sequelize = new Sequelize("postgresql://neondb_owner:npg_YMZ76GrFtLOI@ep-lingering-lab-anhgc5qm-pooler.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require", {
    dialect: 'postgres',
    dialectOptions: {
        ...(useDbSsl ? { 
            ssl: { 
                require: true, 
                rejectUnauthorized: false 
            } 
        } : {}),
        keepAlive: true,
        statement_timeout: 30000,
        idle_in_transaction_session_timeout: 30000,
    },
    logging: process.env.SEQ_LOGGING === 'true' ? console.log : false,
    pool: {
        max: 20,
        min: 0,  // Changed from 5 to 0 to allow lazy connection
        acquire: 60000,
        idle: 10000,
        evict: 10000
    },
});

module.exports = sequelize;