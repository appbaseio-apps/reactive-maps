/* eslint max-lines: 0 */
import React, { Component } from "react";
import PropTypes from 'prop-types';
import { GoogleMap, Marker, InfoWindow, withGoogleMap } from "react-google-maps";
import MarkerClusterer from "react-google-maps/lib/components/addons/MarkerClusterer";
import classNames from "classnames";
import {
	AppbaseChannelManager as manager,
	AppbaseSensorHelper as helper,
	PoweredBy
} from "@appbaseio/reactivebase";
import { SearchAsMove } from "../addons/SearchAsMove";
import { MapStyles, mapStylesCollection } from "../addons/MapStyles";
import * as ReactiveMapHelper from "../helper/ReactiveMapHelper";

import _ from "lodash";

export default class ReactiveMap extends Component {
	constructor(props) {
		super(props);
		this.state = {
			markers: [],
			selectedMarker: null,
			streamingStatus: "Initializing..",
			defaultCenter: this.props.defaultCenter ? this.props.defaultCenter : { lat: 37.74, lon: -122.45 },
			center: this.props.defaultCenter,
			query: {},
			rawData: {
				hits: {
					hits: []
				}
			},
			currentData: [],
			externalData: {},
			mapBounds: null
		};
		this.geoRelatedEvents = ["onDragend", "onZoomChanged"];
		this.previousSelectedSensor = {};
		this.searchAsMoveChange = this.searchAsMoveChange.bind(this);
		this.mapStyleChange = this.mapStyleChange.bind(this);
		this.geoCustomQuery = this.geoCustomQuery.bind(this);
		this.handleMarkerClose = this.handleMarkerClose.bind(this);
		this.queryStartTime = 0;
		this.reposition = false;
		this.mapDefaultHeight = "700px";
	}

	componentDidMount() {
		this.streamProp = this.props.stream;
		this.sizeProp = this.props.size;
		this.initialize();
	}

	componentWillReceiveProps(nextProps) {
		if (!_.isEqual(this.props.react, nextProps.react)) {
			this.setReact(nextProps);
			manager.update(this.channelId, this.react, nextProps.size, nextProps.from, nextProps.stream);
		}

		if (nextProps.defaultMapStyle !== this.props.defaultMapStyle) {
			this.mapStyleChange(this.getMapStyle(nextProps.defaultMapStyle));
		}
	}

	// stop streaming request and remove listener when component will unmount
	componentWillUnmount() {
		this.removeChannel();
	}

	removeChannel() {
		if (this.channelId) {
			manager.stopStream(this.channelId);
			this.channelId = null;
		}
		if (this.channelListener) {
			this.channelListener.remove();
		}
	}

	initialize(updateExecute = false) {
		this.setGeoQueryInfo();
		this.setReact(this.props);
		this.createChannel(updateExecute);
		const currentMapStyle = this.getMapStyle(this.props.defaultMapStyle);
		this.initialMapBoundQuery = this.props.defaultCenter ? true : false;
		this.applyGeoQuery = this.props.applyGeoQuery ? this.props.applyGeoQuery : this.props.setSearchAsMove;
		this.setState({
			currentMapStyle
		});
	}

	getMapStyle(styleName) {
		const selectedStyle = mapStylesCollection.filter(style => style.key === styleName);

		if (selectedStyle.length) {
			return selectedStyle[0].value;
		}
		return null;
	}

	setReact(props) {
		// Set the actuate - add self aggregation query as well with actuate
		const react = Object.assign({}, props.react);
		const reactOr = ["geoQuery"];
		const reactAnd = ["streamChanges"];
		this.react = helper.setupReact(react, reactAnd);
		this.react = ReactiveMapHelper.setupOrReact(this.react, reactOr);
	}

	// Create a channel which passes the actuate and receive results whenever actuate changes
	createChannel() {
		// create a channel and listen the changes
		const channelObj = manager.create(this.context.appbaseRef, this.context.type, this.react, this.props.size, this.props.from, this.props.stream);
		this.channelId = channelObj.channelId;
		this.channelListener = channelObj.emitter.addListener(channelObj.channelId, (res) => {
			const data = res.data;
			// implementation to prevent initialize query issue if old query response is late then the newer query
			// then we will consider the response of new query and prevent to apply changes for old query response.
			// if queryStartTime of channel response is greater than the previous one only then apply changes

			function checkAndGo() {
				if (res.mode === "historic" && res.startTime > this.queryStartTime) {
					this.afterChannelResponse(res);
				} else if (res.mode === "streaming") {
					this.afterChannelResponse(res);
				}
			}

			function initialize() {
				if (res.error && res.startTime > this.queryStartTime) {
					if (this.props.onAllData) {
						const modifiedData = helper.prepareResultData(res);
						this.props.onAllData(modifiedData.res, modifiedData.err);
					}
				} else if (res.appliedQuery) {
					if (!this.state.mapBounds) {
						checkAndGo.call(this);
					} else if (this.props.autoMapRender) {
						checkAndGo.call(this);
					} else if (data.hits.hits.length) {
						checkAndGo.call(this);
					}
				}
			}

			initialize.call(this);
		});
		const obj = {
			key: "streamChanges",
			value: ""
		};
		helper.selectedSensor.set(obj, true);
	}

	afterChannelResponse(res) {
		const getResult = ReactiveMapHelper.afterChannelResponse(res, this.state.rawData, this.props.dataField, this.state.markersData);
		this.reposition = true;
		this.streamFlag = getResult.streamFlag;
		this.queryStartTime = getResult.queryStartTime ? getResult.queryStartTime : 0;
		this.setState({
			rawData: getResult.rawData,
			markersData: getResult.markersData
		}, () => {
			if (this.props.onAllData) {
				// Pass the historic or streaming data in index method
				res.allMarkers = getResult.rawData;
				let modifiedData = JSON.parse(JSON.stringify(res));
				modifiedData.newData = getResult.newData;
				modifiedData.currentData = getResult.currentData;
				delete modifiedData.data;
				modifiedData = helper.prepareResultData(modifiedData, res.data);
				if (this.props.onAllData) {
					if(modifiedData.res) {
						modifiedData.res.mapRef = this.mapRef;
					}
					const generatedData = this.props.onAllData(modifiedData.res, modifiedData.err);
					this.setState({
						externalData: generatedData
					});
				}
			}
			if (this.streamFlag) {
				this.streamMarkerInterval();
			}
		});
	}

	// set the query type and input data
	setGeoQueryInfo() {
		const obj = {
			key: "geoQuery",
			value: {
				queryType: "geo_bounding_box",
				inputData: this.props.dataField,
				customQuery: this.geoCustomQuery
			}
		};
		const obj1 = {
			key: "updateExecute",
			value: {
				queryType: "random",
				inputData: this.props.dataField
			}
		};

		helper.selectedSensor.setSensorInfo(obj);
		helper.selectedSensor.setSensorInfo(obj1);
	}

	geoCustomQuery(value) {
		let query = null;
		if (value && (this.initialMapBoundQuery || this.searchAsMove)) {
			query = {
				geo_bounding_box: {
					[this.props.dataField]: value
				}
			};
			if (this.geoRelatedEventsChange) {
				this.geoRelatedEventsChange = false;
			} else if (this.applyGeoQuery) {
				this.applyGeoQuery = false;
			}
			this.initialMapBoundQuery = false;
		}
		return query;
	}

	updateExecute() {
		setTimeout(() => {
			const obj = {
				key: "updateExecute",
				value: Math.random()
			};
			helper.selectedSensor.set(obj, true);
		}, 1000);
	}

	// Show InfoWindow and re-renders component
	handleMarkerClick(marker) {
		marker.showInfo = true;
		this.reposition = false;
		this.setState({
			rerender: true
		}, () => {
			if(this.props.popoverTTL) {
				this.watchPopoverTTL(marker);
			}
		});
	}

	// Close info window
	handleMarkerClose(marker) {
		marker.showInfo = false;
		this.reposition = false;
		this.setState(this.state);
	}

	// watch and close popover on timeout
	watchPopoverTTL(marker) {
		this.popoverTTLStore = this.popoverTTLStore ? this.popoverTTLStore : {};
		if(this.popoverTTLStore[marker._type+marker._id]) {
			this.clearTTL(marker._type+marker._id);
		} else {
			this.popoverTTLStore[marker._type+marker._id] = setTimeout(() => {
				this.handleMarkerClose(marker);
				this.clearTTL(marker._type+marker._id);
			}, this.props.popoverTTL*1000);
		}
	}

	clearTTL(id) {
		clearTimeout(this.popoverTTLStore[id])
		delete this.popoverTTLStore[id];
	}

	// render info window
	renderInfoWindow(ref, marker) {
		const onPopoverTrigger = this.props.onPopoverTrigger ? this.props.onPopoverTrigger(marker) : "Popver";
		return (
			<InfoWindow
				zIndex={500}
				key={`${ref}_info_window`}
				onCloseClick={() => this.handleMarkerClose(marker)}
			>
				<div>
					{onPopoverTrigger}
				</div>
			</InfoWindow>
		);
	}

	// Handle function which is fired when map is moved and reaches to idle position
	handleOnIdle() {
		const mapBounds = this.mapRef ? this.mapRef.getBounds() : null;
		if (mapBounds) {
			const north = mapBounds.getNorthEast().lat();
			const south = mapBounds.getSouthWest().lat();
			const east = mapBounds.getNorthEast().lng();
			const west = mapBounds.getSouthWest().lng();
			const boundingBoxCoordinates = {
				top_left: [west, north],
				bottom_right: [east, south]
			};
			const stateObj = {
				mapBounds
			};
			if (this.props.onIdle) {
				const generatedData = this.props.onIdle(this.mapRef, {
					boundingBoxCoordinates,
					mapBounds
				});
				stateObj.externalData = generatedData;
			}
			if (this.initialMapBoundQuery || (this.applyGeoQuery || (this.geoRelatedEventsChange && this.searchAsMove && !this.searchQueryProgress))) {
				const flag = this.initialMapBoundQuery ? true : (this.applyGeoQuery ? this.applyGeoQuery : this.searchAsMove);
				this.setValue(boundingBoxCoordinates, flag);
			}
			this.setState(stateObj);
		}
	}

	// Handle function which is fired when map is dragged
	handleOnDrage() {
		this.storeCenter = null;
	}

	// set value
	setValue(value, isExecuteQuery = false) {
		const obj = {
			key: "geoQuery",
			value
		};
		helper.selectedSensor.set(obj, isExecuteQuery);
	}

	// on change of selecting
	searchAsMoveChange(value) {
		this.searchAsMove = value;
		if (value && this.mapRef) {
			this.geoRelatedEventsChange = true;
			this.handleOnIdle();
		}
	}

	// mapStyle changes
	mapStyleChange(style) {
		this.setState({
			currentMapStyle: style
		});
	}

	// Handler function for bounds changed which udpates the map center
	handleBoundsChanged() {
		if (!this.searchQueryProgress) {
			// this.setState({
			//   center: this.mapRef.getCenter()
			// });
		} else {
			setTimeout(() => {
				this.searchQueryProgress = false;
			}, 1000 * 1);
		}
	}

	// Check if stream data exists in markersData
	// and if exists the call streamToNormal.
	streamMarkerInterval() {
		const markersData = this.state.markersData;
		const isStreamData = markersData.filter(hit => hit.stream && hit.streamStart);
		if (isStreamData.length) {
			this.isStreamDataExists = true;
			setTimeout(() => this.streamToNormal(), this.props.streamTTL * 1000);
		} else {
			this.isStreamDataExists = false;
		}
	}

	// Check the difference between current time and attached stream time
	// if difference is equal to streamTTL then delete stream and starStream property of marker
	streamToNormal() {
		let markersData = this.state.markersData;
		const isStreamData = markersData.filter(hit => hit.stream && hit.streamStart);
		if (isStreamData.length) {
			markersData = markersData.map((hit) => {
				if (hit.stream && hit.streamStart) {
					const currentTime = new Date();
					const timeDiff = (currentTime.getTime() - hit.streamStart.getTime()) / 1000;
					if (timeDiff >= this.props.streamTTL) {
						delete hit.stream;
						delete hit.streamStart;
					}
				}
				return hit;
			});
			this.setState({
				markersData
			});
		} else {
			this.isStreamDataExists = false;
		}
	}

	getIcon(hit) {
		return hit.stream ? this.props.streamMarkerImage : this.props.defaultMarkerImage;
	}

	chooseIcon(hit) {
		let icon = hit.external_icon ? hit.external_icon : this.getIcon(hit);
		icon = this.props.onData ? this.props.onData(hit) : icon;
		const isSvg = !!(typeof icon === "object" && ("path" in icon));
		if (isSvg) {
			icon = JSON.parse(JSON.stringify(icon));
			if (this.props.autoMarkerPosition) {
				const deg = hit.angleDeg ? hit.angleDeg : 0;
				icon.rotation = deg;
			}
		}
		return icon;
	}

	// here we accepts marker props which we received from onAllData and apply those external props in Marker component
	combineProps(hit) {
		let externalProps;
		const markerProp = {};
		if (this.state.externalData && this.state.externalData.markers && this.state.externalData.markers[hit._id]) {
			externalProps = this.state.externalData.markers[hit._id];
			Object.keys(externalProps).forEach((externalP) => {
				hit[`external_${externalP}`] = externalProps[externalP];
				markerProp[externalP] = externalProps[externalP];
			});
		}
		markerProp.icon = this.chooseIcon(hit);
		return markerProp;
	}

	generateMarkers() {
		const self = this;
		let markersData = this.state.markersData;
		const response = {
			markerComponent: [],
			defaultCenter: null,
			convertedGeo: []
		};
		if (markersData && markersData.length) {
			markersData = markersData.filter((hit) => {
				return ReactiveMapHelper.identifyGeoData(hit._source[self.props.dataField]);
			});
			response.markerComponent = markersData.map((hit, index) => {
				const field = ReactiveMapHelper.identifyGeoData(hit._source[self.props.dataField]);
				response.convertedGeo.push(field);
				const position = {
					position: field
				};
				const ref = `marker_ref_${index}`;
				let popoverEvent;
				if (this.props.showPopoverOn) {
					popoverEvent = {};
					let eventName = this.props.showPopoverOn.split("");
					eventName[0] = eventName[0].toUpperCase();
					eventName = eventName.join("");
					popoverEvent[`on${eventName}`] = this.handleMarkerClick.bind(this, hit);
				} else {
					popoverEvent = {};
					popoverEvent.onClick = this.handleMarkerClick.bind(this, hit);
				}
				const defaultFn = function() {};
				const events = {
					onClick: this.props.markerOnClick ? this.props.markerOnClick : defaultFn,
					onDblclick: this.props.markerOnDblclick ? this.props.markerOnDblclick : defaultFn,
					onMouseover: this.props.onMouseover ? this.props.onMouseover : defaultFn,
					onMouseout: this.props.onMouseout ? this.props.onMouseout : defaultFn
				};
				return (
					<Marker
						{...position}
						key={hit._id}
						zIndex={1}
						ref={ref}
						{...self.combineProps(hit)}
						onClick={() => events.onClick(hit._source)}
						onDblclick={() => events.onDblclick(hit._source)}
						onMouseover={() => events.onMouseover(hit._source)}
						onMouseout={() => events.onMouseout(hit._source)}
						{...popoverEvent}
					>
						{hit.showInfo ? self.renderInfoWindow(ref, hit) : null}
					</Marker>
				);
			});
			if (response.convertedGeo[0]) {
				response.defaultCenter = {
					lat: response.convertedGeo[0].lat,
					lng: response.convertedGeo[0].lng
				};
			}
		}
		if (!this.props.showMarkers) {
			response.markerComponent = [];
		}
		return response;
	}

	externalData() {
		let recordList = [];
		if (this.state.externalData) {
			Object.keys(this.state.externalData).forEach((record) => {
				if (record !== "markers") {
					recordList = recordList.concat(this.state.externalData[record]);
				}
			});
		}
		return recordList;
	}

	mapEvents(eventName) {
		if (this.geoRelatedEvents.indexOf(eventName) > -1) {
			this.geoRelatedEventsChange = true;
		}
		if (this.props[eventName]) {
			const externalData = this.props[eventName](this.mapRef);
			if (externalData) {
				this.setState({
					externalData
				});
			}
		}
	}

	getStoreCenter() {
		return this.storeCenter ? this.storeCenter : this.state.center;
	}

	render() {
		let markerComponent,
			showSearchAsMove,
			showMapStyles;
		let title = null,
			center = null;
		const centerComponent = {};
		const generatedMarkers = this.generateMarkers();
		if (this.props.setMarkerCluster) {
			markerComponent = (<MarkerClusterer averageCenter enableRetinaIcons gridSize={60} >
				{generatedMarkers.markerComponent}
			</MarkerClusterer>);
		} else {
			markerComponent = generatedMarkers.markerComponent;
		}
		// Auto center using markers data
		let streamCenterFlag = true;
		if (this.channelMethod === "streaming" && !this.props.streamAutoCenter) {
			streamCenterFlag = false;
		}
		if (this.props.autoCenter && this.reposition && streamCenterFlag) {
			center = generatedMarkers.defaultCenter ? generatedMarkers.defaultCenter : this.getStoreCenter();
			this.storeCenter = center;
			this.reposition = false;
			centerComponent.center = ReactiveMapHelper.normalizeCenter(center);
		} else if (this.storeCenter) {
			center = this.storeCenter;
			centerComponent.center = ReactiveMapHelper.normalizeCenter(center);
		} else {
			center = null;
		}

		// include searchasMove component
		if (this.props.showSearchAsMove) {
			showSearchAsMove = <SearchAsMove searchAsMoveDefault={this.props.setSearchAsMove} searchAsMoveChange={this.searchAsMoveChange} />;
		}
		// include mapStyle choose component
		if (this.props.showMapStyles) {
			showMapStyles = <MapStyles defaultSelected={this.props.defaultMapStyle} mapStyleChange={this.mapStyleChange} />;
		}
		// include title if exists
		if (this.props.title) {
			title = (<h4 className="rbc-title col s12 m8 col-xs-12 col-sm-8">{this.props.title}</h4>);
		}

		const cx = classNames({
			"rbc-title-active": this.props.title,
			"rbc-title-inactive": !this.props.title
		}, this.props.className);

		const GettingStartedGoogleMap = withGoogleMap(props => (
			<GoogleMap
				ref={
					(map) => {
						this.mapRef = map;
					}
				}
				{...centerComponent}
				{...ReactiveMapHelper.normalizeProps(this.props)}
				defaultCenter={ReactiveMapHelper.normalizeCenter(this.state.defaultCenter)}
				onDragStart={() => {
					this.handleOnDrage();
					this.mapEvents("onDragStart");
				}
				}
				onIdle={() => this.handleOnIdle()}
				onClick={() => this.mapEvents("onClick")}
				onDblclick={() => this.mapEvents("onDblclick")}
				onDrag={() => this.mapEvents("onDrag")}
				onDragend={() => this.mapEvents("onDragend")}
				onMousemove={() => this.mapEvents("onMousemove")}
				onMouseOut={() => this.mapEvents("onMouseOut")}
				onMouseover={() => this.mapEvents("onMouseover")}
				onResize={() => this.mapEvents("onResize")}
				onRightClick={() => this.mapEvents("onRightClick")}
				onTilesloaded={() => this.mapEvents("onTilesloaded")}
				onBoundsChanged={() => this.mapEvents("onBoundsChanged")}
				onCenterChanged={() => this.mapEvents("onCenterChanged")}
				onProjectionChanged={() => this.mapEvents("onProjectionChanged")}
				onTiltChanged={() => this.mapEvents("onTiltChanged")}
				onZoomChanged={() => this.mapEvents("onZoomChanged")}
			>
				{markerComponent}
				{this.externalData()}
			</GoogleMap>
		));

		return (
			<div className={`rbc rbc-reactivemap col s12 col-xs-12 card thumbnail ${cx}`} style={ReactiveMapHelper.mapPropsStyles(this.props.style, "component")}>
				{title}
				{showMapStyles}
				<GettingStartedGoogleMap
					containerElement={
						<div
							className="rbc-container col s12 col-xs-12"
							style={ReactiveMapHelper.mapPropsStyles(this.props.style, "map", this.mapDefaultHeight)}
						/>
					}
					mapElement={
						<div style={this.state.currentMapStyle} />
					}
				/>
				{showSearchAsMove}
				<PoweredBy />
			</div >
		);
	}
}

ReactiveMap.propTypes = {
	dataField: PropTypes.string.isRequired,
	onIdle: PropTypes.func,
	onAllData: PropTypes.func,
	onData: PropTypes.func,
	onPopoverTrigger: PropTypes.func,
	setMarkerCluster: PropTypes.bool,
	autoMarkerPosition: PropTypes.bool,
	showMarkers: PropTypes.bool,
	streamTTL: ReactiveMapHelper.validation.streamTTL,
	popoverTTL: ReactiveMapHelper.validation.popoverTTL,
	size: helper.sizeValidation,
	from: ReactiveMapHelper.validation.fromValidation,
	autoMapRender: PropTypes.bool,
	style: PropTypes.object,
	autoCenter: PropTypes.bool,
	showSearchAsMove: PropTypes.bool,
	setSearchAsMove: PropTypes.bool,
	defaultMapStyle: PropTypes.oneOf(["Standard", "Blue Essence", "Blue Water", "Flat Map", "Light Monochrome", "Midnight Commander", "Unsaturated Browns"]),
	title: PropTypes.oneOfType([
		PropTypes.string,
		PropTypes.element
	]),
	streamAutoCenter: PropTypes.bool,
	defaultMarkerImage: PropTypes.string,
	streamMarkerImage: PropTypes.string,
	stream: PropTypes.bool,
	defaultZoom: ReactiveMapHelper.validation.defaultZoom,
	applyGeoQuery: PropTypes.bool,
	showPopoverOn: PropTypes.oneOf(["click", "mouseover"]),
	defaultCenter: PropTypes.shape({
		lat: ReactiveMapHelper.validation.validCenter,
		lon: ReactiveMapHelper.validation.validCenter
	}),
	react: PropTypes.object,
	markerOnClick: PropTypes.func,
	markerOnDblclick: PropTypes.func,
	onMouseover: PropTypes.func,
	onMouseout: PropTypes.func,
	showMapStyles: PropTypes.bool,
	className: PropTypes.string
};

ReactiveMap.defaultProps = {
	setMarkerCluster: true,
	autoCenter: true,
	showSearchAsMove: true,
	setSearchAsMove: false,
	showMapStyles: true,
	defaultMapStyle: "Standard",
	from: 0,
	size: 100,
	streamTTL: 5,
	streamAutoCenter: false,
	autoMarkerPosition: false,
	showMarkers: true,
	autoMapRender: true,
	defaultMarkerImage: "https://opensource.appbase.io/reactivemaps/dist/images/historic-pin.png",
	streamMarkerImage: "https://opensource.appbase.io/reactivemaps/dist/images/stream-pin.png",
	style: {},
	stream: false,
	applyGeoQuery: false,
	defaultZoom: 13
};

ReactiveMap.contextTypes = {
	appbaseRef: PropTypes.any.isRequired,
	type: PropTypes.any.isRequired
};
