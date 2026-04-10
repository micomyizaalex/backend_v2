// models/Company.js
const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Company = sequelize.define(
  "Company",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    owner_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id'
      }
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    email: {
      type: DataTypes.STRING,
      unique: true,
      validate: {
        isEmail: true,
      },
    },

    phone: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    address: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    country: {
      type: DataTypes.STRING(100),
      allowNull: false,
      defaultValue: 'Rwanda',
    },

    logo_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    status: {
      type: DataTypes.ENUM("pending", "approved", "suspended", "rejected"),
      defaultValue: "pending",
    },

    rejection_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    approved_by: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },

    approval_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    subscription_status: {
      type: DataTypes.ENUM("inactive", "active", "expired", "suspended"),
      defaultValue: "inactive",
    },

    subscription_start_date: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    subscription_expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    plan: {
      type: DataTypes.ENUM('Starter', 'Growth', 'Enterprise'),
      allowNull: false,
      defaultValue: 'Starter',
    },
  },
  {
    tableName: "companies",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['owner_id'] },
      { fields: ['status'] },
      { fields: ['subscription_status'] },
      { fields: ['plan'] },
      { unique: true, fields: ['name'] },
      { unique: true, fields: ['email'] }
    ]
  }
);

module.exports = Company;