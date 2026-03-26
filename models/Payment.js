const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Payment = sequelize.define(
  "Payment",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    schedule_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    payment_method: {
      type: DataTypes.ENUM("mobile_money", "airtel_money", "card_payment"),
      allowNull: false,
    },

    phone_or_card: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    amount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: "pending",
    },

    booking_status: {
      type: DataTypes.STRING,
      defaultValue: "pending_payment",
      allowNull: false,
    },

    transaction_ref: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
    },

    provider_name: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    provider_reference: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },

    provider_status: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    currency: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'RWF',
    },

    seat_lock_ids: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },

    held_ticket_ids: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },

    seat_numbers: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
    },

    meta: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },

    expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    completed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    failed_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "payments",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ["user_id"] },
      { fields: ["schedule_id"] },
      { fields: ["status"] },
      { fields: ["booking_status"] },
      { fields: ["transaction_ref"] },
      { fields: ["provider_reference"] },
    ],
  }
);

module.exports = Payment;

