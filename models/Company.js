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
    },

    address: {
      type: DataTypes.TEXT,
    },

    country: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },

    rejection_reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    logo_url: {
      type: DataTypes.TEXT,
    },

    status: {
      type: DataTypes.ENUM("pending", "approved", "suspended", "rejected"),
      defaultValue: "pending",
    },

    is_approved: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    approval_date: {
      type: DataTypes.DATE,
    },

    approved_by: {
      type: DataTypes.UUID,
    },

    subscription_status: {
      type: DataTypes.ENUM("inactive", "pending_approval", "active", "expired"),
      defaultValue: "inactive",
    },

    subscription_paid: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    subscription_paid_date: {
      type: DataTypes.DATE,
    },

    subscription_expires_at: {
      type: DataTypes.DATE,
    },

    subscription_amount: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 50000.00,
    },

    plan: {
      type: DataTypes.ENUM('Starter', 'Growth', 'Enterprise'),
      allowNull: false,
      defaultValue: 'Starter',
    },

    next_payment: {
      type: DataTypes.DATEONLY,
      allowNull: true,
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
      { fields: ['plan'] }
    ]
  }
);

module.exports = Company;
