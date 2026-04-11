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
    
    bus_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'buses',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    
    schedule_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'schedules',
        key: 'id'
      },
      onDelete: 'SET NULL'
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
      allowNull: true,
      comment: 'Speed in km/h'
    },
    
    heading: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
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
      { fields: ['bus_id'] },
      { fields: ['bus_id', 'recorded_at'] },
      { fields: ['schedule_id'] },
      { fields: ['recorded_at'] }
    ]
  }
);

module.exports = LiveBusLocation;