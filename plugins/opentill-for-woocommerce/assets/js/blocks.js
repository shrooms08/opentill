/**
 * OpenTill — WooCommerce Blocks (Cart/Checkout) client registration.
 *
 * Plain browser JS, no build step: it leans on the globals WooCommerce Blocks
 * already loads (window.wc, window.wp). Title/description come from the classic
 * gateway settings via wc.wcSettings ('opentill_data'). Selecting the method
 * and paying is handled by the classic gateway's process_payment server-side —
 * this file only makes the option appear and render its label/description.
 */
( function ( wc, wp ) {
	if ( ! wc || ! wc.wcBlocksRegistry || ! wc.wcSettings || ! wp || ! wp.element ) {
		return;
	}

	var settings = wc.wcSettings.getSetting( 'opentill_data', {} );
	var decode = wp.htmlEntities && wp.htmlEntities.decodeEntities
		? wp.htmlEntities.decodeEntities
		: function ( s ) { return s; };

	var label = decode( settings.title || 'Bitcoin (OpenTill)' );
	var description = decode( settings.description || '' );

	var Label = function () {
		return wp.element.createElement( 'span', null, label );
	};

	var Content = function () {
		return wp.element.createElement( 'div', null, description );
	};

	wc.wcBlocksRegistry.registerPaymentMethod( {
		name: 'opentill',
		label: wp.element.createElement( Label, null ),
		content: wp.element.createElement( Content, null ),
		edit: wp.element.createElement( Content, null ),
		ariaLabel: label,
		canMakePayment: function () {
			return true;
		},
		supports: {
			features: ( settings && settings.supports ) || [ 'products' ],
		},
	} );
} )( window.wc, window.wp );
