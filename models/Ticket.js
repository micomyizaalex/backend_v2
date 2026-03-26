const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Ticket = sequelize.define(
  "Ticket",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    passenger_id: { type: DataTypes.UUID, allowNull: false },
    schedule_id: { type: DataTypes.UUID, allowNull: false },
    company_id: { type: DataTypes.UUID, allowNull: false },
    payment_id: { type: DataTypes.UUID, allowNull: true },

    seat_number: { type: DataTypes.STRING, allowNull: false },
    route_id: { type: DataTypes.STRING, allowNull: true },
    trip_date: { type: DataTypes.DATEONLY, allowNull: true },
    from_stop: { type: DataTypes.STRING, allowNull: true },
    to_stop: { type: DataTypes.STRING, allowNull: true },
    from_sequence: { type: DataTypes.INTEGER, allowNull: true },
    to_sequence: { type: DataTypes.INTEGER, allowNull: true },
    booking_ref: { type: DataTypes.STRING, allowNull: false, unique: true },
    qr_code_url: DataTypes.TEXT,
    price: { type: DataTypes.DECIMAL, allowNull: false },

    status: {
      type: DataTypes.ENUM("PENDING_PAYMENT", "CONFIRMED", "CANCELLED", "EXPIRED", "CHECKED_IN"),
      defaultValue: "PENDING_PAYMENT",
    },
    lock_id: { type: DataTypes.UUID, allowNull: true },

    booked_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    checked_in_at: { type: DataTypes.DATE },
  },
  {
    tableName: "tickets",
    timestamps: true,
    underscored: true,
  }
);



module.exports = Ticket;
