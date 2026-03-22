const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const LiveBusLocation = sequelize.define(
  "LiveBusLocation",
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false,
      defaultValue: DataTypes.UUIDV4,
    },
    schedule_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'bus_schedules',
        key: 'schedule_id'
      },
      onDelete: 'CASCADE'
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: false,
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: false,
    },
    speed: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: null,
      comment: 'Speed in km/h'
    },
    heading: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: null,
      comment: 'Direction in degrees (0-360)'
    },
    recorded_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  },
  {
    tableName: "live_bus_locations",
    timestamps: true,
    underscored: true,
    indexes: [
      { fields: ['schedule_id', 'recorded_at'] },
      { fields: ['schedule_id', 'updated_at'] },
      { fields: ['recorded_at'] }
    ]
  }
);

module.exports = LiveBusLocation;
